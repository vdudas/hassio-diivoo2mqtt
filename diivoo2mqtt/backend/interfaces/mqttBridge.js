// ###############################################################
// #                                                             #
// #                           NOTICE                            #
// #                                                             #
// #   THIS SOFTWARE IS THE PROPERTY OF AND CONTAINS             #
// #   CONFIDENTIAL INFORMATION OF INFOR AND/OR ITS AFFILIATES   #
// #   OR SUBSIDIARIES AND SHALL NOT BE DISCLOSED WITHOUT PRIOR  #
// #   WRITTEN PERMISSION. LICENSED CUSTOMERS MAY COPY AND       #
// #   ADAPT THIS SOFTWARE FOR THEIR OWN USE IN ACCORDANCE WITH  #
// #   THE TERMS OF THEIR SOFTWARE LICENSE AGREEMENT.            #
// #   ALL OTHER RIGHTS RESERVED.                                #
// #                                                             #
// #   (c) COPYRIGHT 2025 INFOR.  ALL RIGHTS RESERVED.           #
// #   THE WORD AND DESIGN MARKS SET FORTH HEREIN ARE            #
// #   TRADEMARKS AND/OR REGISTERED TRADEMARKS OF INFOR          #
// #   AND/OR ITS AFFILIATES AND SUBSIDIARIES. ALL RIGHTS        #
// #   RESERVED.  ALL OTHER TRADEMARKS LISTED HEREIN ARE         #
// #   THE PROPERTY OF THEIR RESPECTIVE OWNERS.                  #
// #                                                             #
// ###############################################################

// interfaces/mqttBridge.js
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const { normalizeSchedule, countTotalSchedules } = require('../core/channelConfig');

function loadLocale(lang) {
    const localesDir = path.join(__dirname, '..', 'locales');
    const file = path.join(localesDir, `${lang}.json`);

    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (err) {
        console.warn(`[MQTT] Failed to load locale '${lang}': ${err.message}. Falling back to en.json.`);
    }

    const enFile = path.join(localesDir, 'en.json');
    try {
        return JSON.parse(fs.readFileSync(enFile, 'utf8'));
    } catch (err) {
        console.warn(`[MQTT] Failed to load en.json locale: ${err.message}. Using hardcoded fallback.`);
        return {};
    }
}

function t(strings, key, vars = {}) {
    let str = strings[key] || key;
    for (const [k, v] of Object.entries(vars)) {
        str = str.replace(`{${k}}`, v);
    }
    return str;
}

class MqttBridge {
    constructor(hub, config) {
        this.hub = hub;
        this.config = config;
        this.discoveryPrefix = config.discoveryPrefix || 'homeassistant';
        this.strings = loadLocale(config.language || 'en');

        this.discoveredValves = new Set();
        this.discoveredGateways = new Set();
        this.gatewayStates = new Map();

        this.client = mqtt.connect(config.brokerUrl, {
            username: config.username,
            password: config.password
        });

        this.client.on('connect', async () => {
            console.log('[MQTT] Connected to broker');

            // Eingehende Befehle von Home Assistant
            this.client.subscribe([
                'diivoo/+/valve/+/set',
                'diivoo/+/ch/+/rain_delay/set',
                'diivoo/gateway/+/led/set',
                'diivoo/gateway/+/portal/press',
                'diivoo/gateway/+/clearwifi/press',
                'diivoo/gateway/+/version/get',
                'diivoo/gateway/+/update/set',
                'diivoo/+/ch/+/default_duration/set',
                'diivoo/+/ch/+/mist_on/set',
                'diivoo/+/ch/+/mist_off/set',
                'diivoo/+/ch/+/schedules/set',
                'diivoo/+/valve/+/cmd',
            ]);

            // Discovery für bekannte Geräte/Gateways rausschieben
            this.publishKnownValveDiscovery();
            this.publishKnownGatewayDiscovery();

            // Initialzustände publizieren
            this.publishAllDeviceStates();
            await this.refreshGatewayStates();
        });

        this.client.on('message', this.handleIncomingMessage.bind(this));

        // Ventil-Updates
        this.hub.on('deviceUpdate', this.publishDeviceState.bind(this));
        this.hub.on('deviceRenamed', ({ valveId }) => {
            const device = this.hub.devices.get(valveId);
            if (!device) return;
            this.discoveredValves.delete(valveId);
            this.publishAutoDiscovery(device.getLiveState());
        });

        // Gateway-Updates
        this.hub.on('gatewayButton', this.handleGatewayButton.bind(this));
        this.hub.on('gatewayVersion', this.handleGatewayVersion.bind(this));
        this.hub.on('gatewayConnection', this.handleGatewayConnection.bind(this));

        // OTA-Updates
        if (this.hub.otaManager) {
            this.hub.otaManager.on('updateAvailable', this.publishGatewayUpdateState.bind(this));
        }
        this.hub.on('gatewayOtaStatus', this.handleGatewayOtaStatus.bind(this));
    }

    // ------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------

    _getGatewayIds() {
        if (Array.isArray(this.hub.gatewayConfigs) && this.hub.gatewayConfigs.length > 0) {
            return this.hub.gatewayConfigs.map(gw => gw.id);
        }
        if (this.hub.gateways instanceof Map) {
            return Array.from(this.hub.gateways.keys());
        }
        return [];
    }

    _getGatewayState(gatewayId) {
        if (!this.gatewayStates.has(gatewayId)) {
            this.gatewayStates.set(gatewayId, {
                ledState: 'OFF',
                buttonPressed: false,
                version: '',
                model: '',
                connected: false,
                lastUpdateTs: Date.now()
            });
        }
        return this.gatewayStates.get(gatewayId);
    }

    _getGatewayNode(gatewayId) {
        if (typeof this.hub.getGateway === 'function') {
            return this.hub.getGateway(gatewayId);
        }
        if (this.hub.gateways instanceof Map) {
            return this.hub.gateways.get(gatewayId) || null;
        }
        return null;
    }

    _safeJsonParse(raw) {
        try {
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    _extractOnOff(rawMessage) {
        const raw = rawMessage.toString().trim();
        const parsed = this._safeJsonParse(raw);

        if (parsed && typeof parsed === 'object') {
            const state = String(parsed.state || '').toUpperCase();
            if (state === 'ON' || state === 'OFF') {
                return state;
            }
        }

        const upper = raw.toUpperCase();
        if (upper === 'ON' || upper === 'OFF') {
            return upper;
        }

        return null;
    }

    _publish(topic, payload, options = { retain: true }) {
        this.client.publish(topic, payload, options);
    }

    // ------------------------------------------------------------
    // Home Assistant Discovery - Ventile
    // ------------------------------------------------------------

    publishKnownValveDiscovery() {
        for (const device of this.hub.devices.values()) {
            this.publishAutoDiscovery(device.getLiveState());
        }
    }

    publishAutoDiscovery(deviceLiveState) {
        const valveId = deviceLiveState.valveId;
        const model = deviceLiveState.model;
        const channelCount = Object.keys(deviceLiveState.channels).length;

        if (!this.discoveredValves.has(valveId)) {
            this.discoveredValves.add(valveId);
        }

        const deviceBase = {
            identifiers: [`diivoo_${valveId}`],
            name: deviceLiveState.alias || `Diivoo ${model} (${valveId})`,
            manufacturer: 'Diivoo Custom Hub',
            model: model
        };

        const stateTopic = `diivoo/${valveId}/state`;
        const discoveryPrefix = this.discoveryPrefix;

        // Batterie
        this._publish(
            `${discoveryPrefix}/sensor/${valveId}_battery/config`,
            JSON.stringify({
                name: null,
                unique_id: `diivoo_${valveId}_battery`,
                state_topic: stateTopic,
                value_template: '{{ value_json.batteryPercent }}',
                device_class: 'battery',
                unit_of_measurement: '%',
                entity_category: 'diagnostic',
                device: deviceBase
            })
        );

        // Online Status
        this._publish(
            `${discoveryPrefix}/binary_sensor/${valveId}_online/config`,
            JSON.stringify({
                name: null,
                unique_id: `diivoo_${valveId}_online`,
                state_topic: stateTopic,
                value_template: "{{ 'ON' if value_json.isOnline else 'OFF' }}",
                device_class: 'connectivity',
                entity_category: 'diagnostic',
                device: deviceBase
            })
        );

        // Kanäle
        for (let ch = 1; ch <= channelCount; ch++) {
            // Ventil
            this._publish(
                `${discoveryPrefix}/switch/${valveId}_ch${ch}/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve', { ch }),
                    unique_id: `diivoo_${valveId}_valve_${ch}`,
                    state_topic: stateTopic,
                    command_topic: `diivoo/${valveId}/valve/${ch}/set`,
                    value_template: `{{ 'ON' if value_json.channels['${ch}'].isRunning else 'OFF' }}`,
                    payload_on: 'ON',
                    payload_off: 'OFF',
                    icon: 'mdi:water-pump',
                    device: deviceBase
                })
            );

            // Restzeit
            this._publish(
                `${discoveryPrefix}/sensor/${valveId}_ch${ch}_remaining/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_remaining', { ch }),
                    unique_id: `diivoo_${valveId}_remaining_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].remainingLive }}`,
                    device_class: 'duration',
                    unit_of_measurement: 's',
                    device: deviceBase
                })
            );

            // Quelle
            this._publish(
                `${discoveryPrefix}/sensor/${valveId}_ch${ch}_source/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_source', { ch }),
                    unique_id: `diivoo_${valveId}_source_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].source }}`,
                    icon: 'mdi:information-outline',
                    entity_category: 'diagnostic',
                    device: deviceBase
                })
            );

            // Remove old select entity if it exists
            this._publish(`${discoveryPrefix}/select/${valveId}_ch${ch}_rain_delay/config`, '', { retain: true });

            // Rain Delay (hours, 0 = off)
            this._publish(
                `${discoveryPrefix}/number/${valveId}_ch${ch}_rain_delay/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_rain_delay', { ch }),
                    unique_id: `diivoo_${valveId}_rain_delay_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].rainDelayHours }}`,
                    command_topic: `diivoo/${valveId}/ch/${ch}/rain_delay/set`,
                    min: 0,
                    max: 168,
                    step: 1,
                    unit_of_measurement: 'h',
                    icon: 'mdi:weather-rainy',
                    device: deviceBase
                })
            );

            // Rain Delay expiry sensor (shows actual end datetime or 'Off')
            this._publish(
                `${discoveryPrefix}/sensor/${valveId}_ch${ch}_rain_delay_until/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_rain_delay_until', { ch }),
                    unique_id: `diivoo_${valveId}_rain_delay_until_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].rainDelayUntil }}`,
                    icon: 'mdi:calendar-clock',
                    entity_category: 'diagnostic',
                    device: deviceBase
                })
            );

            // Default Duration (Number Entity)
            this._publish(
                `${discoveryPrefix}/number/${valveId}_ch${ch}_default_duration/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_default_duration', { ch }),
                    unique_id: `diivoo_${valveId}_default_duration_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].defaultOpenSeconds }}`,
                    command_topic: `diivoo/${valveId}/ch/${ch}/default_duration/set`,
                    min: 1,
                    max: 65535,
                    step: 1,
                    unit_of_measurement: 's',
                    icon: 'mdi:timer-outline',
                    entity_category: 'config',
                    device: deviceBase
                }),
                { retain: true }
            );

            // Misting On-Time (Number Entity)
            this._publish(
                `${discoveryPrefix}/number/${valveId}_ch${ch}_mist_on/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_mist_on', { ch }),
                    unique_id: `diivoo_${valveId}_mist_on_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].intervalOnSeconds }}`,
                    command_topic: `diivoo/${valveId}/ch/${ch}/mist_on/set`,
                    min: 1,
                    max: 3600,
                    step: 1,
                    unit_of_measurement: 's',
                    icon: 'mdi:spray',
                    entity_category: 'config',
                    device: deviceBase
                }),
                { retain: true }
            );

            // Misting Off-Interval (Number Entity)
            this._publish(
                `${discoveryPrefix}/number/${valveId}_ch${ch}_mist_off/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_mist_off', { ch }),
                    unique_id: `diivoo_${valveId}_mist_off_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].intervalOffSeconds }}`,
                    command_topic: `diivoo/${valveId}/ch/${ch}/mist_off/set`,
                    min: 1,
                    max: 3600,
                    step: 1,
                    unit_of_measurement: 's',
                    icon: 'mdi:spray',
                    entity_category: 'config',
                    device: deviceBase
                }),
                { retain: true }
            );

            // Water Consumption (Diagnostic Sensor)
            this._publish(
                `${discoveryPrefix}/sensor/${valveId}_ch${ch}_water_consumption/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_water_consumption', { ch }),
                    unique_id: `diivoo_${valveId}_water_consumption_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].lastWaterConsumption }}`,
                    device_class: 'water',
                    unit_of_measurement: 'mL',
                    state_class: 'measurement',
                    entity_category: 'diagnostic',
                    device: deviceBase
                }),
                { retain: true }
            );

            // Last Run Duration (Diagnostic Sensor)
            this._publish(
                `${discoveryPrefix}/sensor/${valveId}_ch${ch}_last_duration/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_last_duration', { ch }),
                    unique_id: `diivoo_${valveId}_last_duration_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].lastElapsedSeconds }}`,
                    device_class: 'duration',
                    unit_of_measurement: 's',
                    entity_category: 'diagnostic',
                    device: deviceBase
                }),
                { retain: true }
            );

            // Last Event Timestamp (Diagnostic Sensor)
            this._publish(
                `${discoveryPrefix}/sensor/${valveId}_ch${ch}_last_event/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_last_event', { ch }),
                    unique_id: `diivoo_${valveId}_last_event_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].lastEventDate }}`,
                    device_class: 'timestamp',
                    entity_category: 'diagnostic',
                    device: deviceBase
                }),
                { retain: true }
            );

            // Target Runtime (Diagnostic Sensor)
            this._publish(
                `${discoveryPrefix}/sensor/${valveId}_ch${ch}_target_runtime/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_target_runtime', { ch }),
                    unique_id: `diivoo_${valveId}_target_runtime_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].targetRuntime }}`,
                    device_class: 'duration',
                    unit_of_measurement: 's',
                    entity_category: 'diagnostic',
                    device: deviceBase
                }),
                { retain: true }
            );

            // Schedules (JSON Sensor)
            this._publish(
                `${discoveryPrefix}/sensor/${valveId}_ch${ch}_schedules/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_schedules', { ch }),
                    unique_id: `diivoo_${valveId}_schedules_${ch}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.channels['${ch}'].scheduleCount }} schedules`,
                    json_attributes_topic: `diivoo/${valveId}/ch/${ch}/schedules/attributes`,
                    icon: 'mdi:calendar-clock',
                    device: deviceBase
                }),
                { retain: true }
            );

            // Valve Entity (Water)
            this._publish(
                `${discoveryPrefix}/valve/${valveId}_ch${ch}/config`,
                JSON.stringify({
                    name: t(this.strings, 'valve_water', { ch }),
                    unique_id: `diivoo_${valveId}_valve_${ch}`,
                    device_class: 'water',
                    reports_position: false,
                    state_topic: stateTopic,
                    value_template: `{{ 'open' if value_json.channels['${ch}'].isRunning else 'closed' }}`,
                    command_topic: `diivoo/${valveId}/valve/${ch}/cmd`,
                    payload_open: 'OPEN',
                    payload_close: 'CLOSE',
                    icon: 'mdi:water-pump',
                    device: deviceBase
                }),
                { retain: true }
            );
        }

        // Device-level diagnostic sensors (outside channel loop)

        // Firmware Version
        this._publish(
            `${discoveryPrefix}/sensor/${valveId}_firmware/config`,
            JSON.stringify({
                name: t(this.strings, 'valve_firmware'),
                unique_id: `diivoo_${valveId}_firmware`,
                state_topic: stateTopic,
                value_template: '{{ value_json.firmwareVersion }}',
                icon: 'mdi:chip',
                entity_category: 'diagnostic',
                device: deviceBase
            }),
            { retain: true }
        );

        // Hardware Revision
        this._publish(
            `${discoveryPrefix}/sensor/${valveId}_hw_revision/config`,
            JSON.stringify({
                name: t(this.strings, 'valve_hw_revision'),
                unique_id: `diivoo_${valveId}_hw_revision`,
                state_topic: stateTopic,
                value_template: '{{ value_json.hardwareRevision }}',
                icon: 'mdi:information-outline',
                entity_category: 'diagnostic',
                device: deviceBase
            }),
            { retain: true }
        );

        // RSSI
        this._publish(
            `${discoveryPrefix}/sensor/${valveId}_rssi/config`,
            JSON.stringify({
                name: t(this.strings, 'valve_rssi'),
                unique_id: `diivoo_${valveId}_rssi`,
                state_topic: stateTopic,
                value_template: '{{ value_json.bestRssi }}',
                device_class: 'signal_strength',
                unit_of_measurement: 'dBm',
                entity_category: 'diagnostic',
                device: deviceBase
            }),
            { retain: true }
        );
    }

    publishDeviceState(updateData) {
        const valveId = updateData.valveId;
        const device = this.hub.devices.get(valveId);

        this.publishAutoDiscovery(updateData.state);
        this._publish(`diivoo/${valveId}/state`, JSON.stringify(updateData.state));

        // Publish schedule attributes after state
        if (device) {
            this.publishScheduleAttributes(device);
        }
    }

    publishScheduleAttributes(device) {
        for (let ch = 1; ch <= (device.channelCount || 0); ch++) {
            const channel = device.channels?.[ch];
            const schedules = Array.isArray(channel?.schedules) ? channel.schedules : [];
            this._publish(
                `diivoo/${device.valveId}/ch/${ch}/schedules/attributes`,
                JSON.stringify({ schedules }),
                { retain: true }
            );
        }
    }

    publishAllDeviceStates() {
        for (const device of this.hub.devices.values()) {
            const state = device.getLiveState();
            this.publishAutoDiscovery(state);
            this._publish(`diivoo/${state.valveId}/state`, JSON.stringify(state));
        }
    }

    // ------------------------------------------------------------
    // Home Assistant Discovery - Gateways
    // ------------------------------------------------------------

    publishKnownGatewayDiscovery() {
        for (const gatewayId of this._getGatewayIds()) {
            this.publishGatewayAutoDiscovery(gatewayId);
            this.publishGatewayState(gatewayId);
        }
    }

    publishGatewayAutoDiscovery(gatewayId) {
        if (!this.discoveredGateways.has(gatewayId)) {
            this.discoveredGateways.add(gatewayId);
        }

        const gwState = this._getGatewayState(gatewayId);
        const stateTopic = `diivoo/gateway/${gatewayId}/state`;
        const discoveryPrefix = this.discoveryPrefix;

        const deviceBase = {
            identifiers: [`diivoo_gateway_${gatewayId}`],
            name: `Diivoo Gateway ${gatewayId}`,
            manufacturer: 'Diivoo Custom Hub',
            model: gwState.model || 'Custom Gateway'
        };

        // LED als Light
        // Wichtig: HA erwartet bei schema=json ein JSON mit top-level "state"
        this._publish(
            `${discoveryPrefix}/light/gateway_${gatewayId}_led/config`,
            JSON.stringify({
                name: t(this.strings, 'gateway_led'),
                unique_id: `diivoo_gateway_${gatewayId}_led`,
                schema: 'json',
                state_topic: stateTopic,
                command_topic: `diivoo/gateway/${gatewayId}/led/set`,
                icon: 'mdi:led-on',
                device: deviceBase
            })
        );

        // Version als String-Sensor
        this._publish(
            `${discoveryPrefix}/sensor/gateway_${gatewayId}_version/config`,
            JSON.stringify({
                name: t(this.strings, 'gateway_version'),
                unique_id: `diivoo_gateway_${gatewayId}_version`,
                state_topic: stateTopic,
                value_template: '{{ value_json.version }}',
                icon: 'mdi:tag-text-outline',
                entity_category: 'diagnostic',
                device: deviceBase
            })
        );

        // Modell als String-Sensor
        this._publish(
            `${discoveryPrefix}/sensor/gateway_${gatewayId}_model/config`,
            JSON.stringify({
                name: t(this.strings, 'gateway_model'),
                unique_id: `diivoo_gateway_${gatewayId}_model`,
                state_topic: stateTopic,
                value_template: '{{ value_json.model }}',
                icon: 'mdi:chip',
                entity_category: 'diagnostic',
                device: deviceBase
            })
        );

        // Online Status
        this._publish(
            `${discoveryPrefix}/binary_sensor/gateway_${gatewayId}_online/config`,
            JSON.stringify({
                name: null,
                unique_id: `diivoo_gateway_${gatewayId}_online`,
                state_topic: stateTopic,
                value_template: "{{ 'ON' if value_json.connected else 'OFF' }}",
                device_class: 'connectivity',
                entity_category: 'diagnostic',
                device: deviceBase
            })
        );

        // Button als Binary Sensor
        this._publish(
            `${discoveryPrefix}/binary_sensor/gateway_${gatewayId}_button/config`,
            JSON.stringify({
                name: t(this.strings, 'gateway_button'),
                unique_id: `diivoo_gateway_${gatewayId}_button`,
                state_topic: stateTopic,
                value_template: "{{ 'ON' if value_json.buttonPressed else 'OFF' }}",
                icon: 'mdi:gesture-tap-button',
                device: deviceBase
            })
        );

        // Portal starten
        this._publish(
            `${discoveryPrefix}/button/gateway_${gatewayId}_portal/config`,
            JSON.stringify({
                name: t(this.strings, 'gateway_portal'),
                unique_id: `diivoo_gateway_${gatewayId}_portal`,
                command_topic: `diivoo/gateway/${gatewayId}/portal/press`,
                payload_press: 'PRESS',
                icon: 'mdi:wifi-cog',
                entity_category: 'config',
                device: deviceBase
            })
        );

        // WLAN löschen
        this._publish(
            `${discoveryPrefix}/button/gateway_${gatewayId}_clearwifi/config`,
            JSON.stringify({
                name: t(this.strings, 'gateway_clearwifi'),
                unique_id: `diivoo_gateway_${gatewayId}_clearwifi`,
                command_topic: `diivoo/gateway/${gatewayId}/clearwifi/press`,
                payload_press: 'PRESS',
                icon: 'mdi:wifi-remove',
                entity_category: 'config',
                device: deviceBase
            })
        );

        // Version neu abfragen
        this._publish(
            `${discoveryPrefix}/button/gateway_${gatewayId}_refresh_version/config`,
            JSON.stringify({
                name: t(this.strings, 'gateway_refresh_version'),
                unique_id: `diivoo_gateway_${gatewayId}_refresh_version`,
                command_topic: `diivoo/gateway/${gatewayId}/version/get`,
                payload_press: 'PRESS',
                icon: 'mdi:refresh',
                entity_category: 'diagnostic',
                device: deviceBase
            })
        );

        // Update Entity (OTA)
        this._publish(
            `${discoveryPrefix}/update/gateway_${gatewayId}_fw/config`,
            JSON.stringify({
                name: t(this.strings, 'firmware_update'),
                unique_id: `diivoo_gateway_${gatewayId}_update`,
                state_topic: `diivoo/gateway/${gatewayId}/update`,
                command_topic: `diivoo/gateway/${gatewayId}/update/set`,
                payload_install: 'INSTALL',
                device_class: 'firmware',
                installed_version_template: '{{ value_json.installed_version }}',
                latest_version_template: '{{ value_json.latest_version }}',
                title_template: '{{ value_json.title }}',
                device: deviceBase
            })
        );
    }

    publishGatewayUpdateState(info) {
        const payload = {
            installed_version: info.oldVersion || '0.0.0',
            latest_version: info.newVersion,
            title: `Diivoo Gateway Firmware`
        };
        this._publish(`diivoo/gateway/${info.gatewayId}/update`, JSON.stringify(payload));
    }

    publishGatewayState(gatewayId) {
        this.publishGatewayAutoDiscovery(gatewayId);

        const gwNode = this._getGatewayNode(gatewayId);
        const gwState = this._getGatewayState(gatewayId);

        const connected =
            typeof gwState.connected === 'boolean'
                ? gwState.connected
                : !!gwNode?.isConnected;

        const payload = {
            gatewayId,
            connected,

            // Für HA Light mit schema=json
            state: gwState.ledState || 'OFF',

            // Zusätzliche Infos
            led: gwState.ledState || 'OFF',
            buttonPressed: !!gwState.buttonPressed,
            version: gwState.version || '',
            model: gwState.model || '',
            lastUpdate: new Date(gwState.lastUpdateTs || Date.now()).toISOString()
        };

        this._publish(`diivoo/gateway/${gatewayId}/state`, JSON.stringify(payload));
    }

    async refreshGatewayStates() {
        for (const gatewayId of this._getGatewayIds()) {
            this.publishGatewayState(gatewayId);

            try {
                await this.hub.getGatewayVersion(gatewayId);
            } catch (err) {
                console.warn(`[MQTT] Could not query gateway version for ${gatewayId}: ${err.message}`);
            }
        }
    }

    handleGatewayButton(ev) {
        const gwState = this._getGatewayState(ev.gatewayId);
        gwState.buttonPressed = !!ev.pressed;
        gwState.lastUpdateTs = Date.now();

        this.publishGatewayState(ev.gatewayId);
    }

    handleGatewayVersion(ev) {
        const { gatewayId, version, model } = ev;
        const gwState = this._getGatewayState(gatewayId);
        gwState.version = version || gwState.version;
        gwState.model = model || gwState.model;
        gwState.lastUpdateTs = Date.now();

        this.publishGatewayState(gatewayId);

        // Fallback: Falls ACK:OTA_OK nicht ankam aber das Gateway jetzt mit der neuen Version antwortet
        const gw = this._getGatewayNode(gatewayId);
        if (gw?.otaPendingVersion && version === gw.otaPendingVersion) {
            console.log(`[MQTT] OTA success confirmed via version fallback: ${gatewayId} is now on ${version}`);
            this._publish(`diivoo/gateway/${gatewayId}/update`, JSON.stringify({
                installed_version: version,
                latest_version: version,
                title: 'Diivoo Gateway Firmware',
                in_progress: false
            }));
            gw.otaPendingVersion = null;
        }

        // Prüfe passiv, ob für diese neu gemeldete Version ein Update bereitsteht
        if (this.hub.otaManager) {
            this.hub.otaManager.evaluateGatewayVersion(gatewayId);
        }
    }

    handleGatewayConnection(ev) {
        const gwState = this._getGatewayState(ev.gatewayId);
        gwState.connected = !!ev.connected;
        gwState.lastUpdateTs = ev.ts || Date.now();

        console.log(
            `[MQTT] Gateway ${ev.gatewayId} is now ${ev.connected ? 'online' : 'offline'} (${ev.reason || 'unknown'})`
        );

        this.publishGatewayState(ev.gatewayId);
    }

    handleGatewayOtaStatus(ev) {
        const { gatewayId, status } = ev;
        const updateInfo = this.hub.otaManager?.getUpdateInfo(gatewayId);

        console.log(`[MQTT] OTA Status von Gateway ${gatewayId}: ${status}`);

        if (status === 'ACK:OTA_START') {
            // OTA hat begonnen → in_progress: true an HA melden
            if (updateInfo) {
                this._publish(`diivoo/gateway/${gatewayId}/update`, JSON.stringify({
                    installed_version: updateInfo.currentVersion,
                    latest_version: updateInfo.latestVersion,
                    title: 'Diivoo Gateway Firmware',
                    in_progress: true
                }));
            }
        } else if (status === 'ACK:OTA_OK') {
            // Erfolgreich geflasht → neue Version als installiert melden, Gateway wird jetzt neustarten
            const gw = this.hub.gateways.get(gatewayId);
            const latestVersion = updateInfo?.latestVersion || (gw?.lastVersion?.version);
            if (updateInfo) {
                this._publish(`diivoo/gateway/${gatewayId}/update`, JSON.stringify({
                    installed_version: latestVersion,
                    latest_version: latestVersion,
                    title: 'Diivoo Gateway Firmware',
                    in_progress: false
                }));
            }
            // lastSeenAt auf 0 setzen damit Gateway sofort als Offline erkannt wird
            if (gw) gw.lastSeenAt = 0;
        } else if (status.startsWith('ERR:OTA_')) {
            // Fehler → in_progress zurücksetzen
            if (updateInfo) {
                this._publish(`diivoo/gateway/${gatewayId}/update`, JSON.stringify({
                    installed_version: updateInfo.currentVersion,
                    latest_version: updateInfo.latestVersion,
                    title: 'Diivoo Gateway Firmware',
                    in_progress: false
                }));
            }
            console.error(`[MQTT] OTA failed for ${gatewayId}: ${status}`);
        }
    }

    // ------------------------------------------------------------
    // Eingehende MQTT-Kommandos
    // ------------------------------------------------------------

    async handleIncomingMessage(topic, message) {
        const parts = topic.split('/');
        const raw = message.toString();

        // --------------------------------------------------------
        // Ventile: diivoo/{valveId}/valve/{channelId}/set
        // --------------------------------------------------------
        if (parts.length === 5 && parts[0] === 'diivoo' && parts[2] === 'valve' && parts[4] === 'set') {
            const valveId = parseInt(parts[1], 10);
            const channelId = parseInt(parts[3], 10);

            const device = this.hub.devices.get(valveId);
            if (!device) return;

            const parsed = this._safeJsonParse(raw);
            const simpleState = this._extractOnOff(raw);

            try {
                if (parsed && typeof parsed === 'object' && parsed.state) {
                    if (String(parsed.state).toUpperCase() === 'ON') {
                        const duration = parsed.duration || 600;
                        await device.valve(channelId).on(duration);
                    } else if (String(parsed.state).toUpperCase() === 'OFF') {
                        await device.valve(channelId).off();
                    }
                    return;
                }

                if (simpleState === 'ON') {
                    await device.valve(channelId).on(600);
                } else if (simpleState === 'OFF') {
                    await device.valve(channelId).off();
                }
            } catch (err) {
                console.error(`[MQTT] Valve command failed: ${err.message}`);
            }

            return;
        }

        // --------------------------------------------------------
        // Rain Delay: diivoo/{valveId}/ch/{channelId}/rain_delay/set
        // Payload: 'Off' | '24 hours' | '48 hours' | '72 hours' | '1 week'
        // --------------------------------------------------------
        if (parts.length === 6 && parts[0] === 'diivoo' && parts[2] === 'ch' && parts[4] === 'rain_delay' && parts[5] === 'set') {
            const valveId = parseInt(parts[1], 10);
            const channelId = parseInt(parts[3], 10);

            const device = this.hub.devices.get(valveId);
            if (!device) return;

            const channel = device.channels?.[channelId];
            if (!channel) return;

            if (!channel.settings) {
                channel.settings = { durationSeconds: 600, intervalOnSeconds: 10, intervalOffSeconds: 30, rainDelayDate: null };
            }

            const hours = Math.round(parseFloat(raw.trim()));

            if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
                console.warn(`[MQTT] Invalid rain delay hours: ${raw}`);
                return;
            }

            channel.settings.rainDelayDate = hours > 0 ? new Date(Date.now() + hours * 3600000) : null;

            console.log(`[MQTT] Rain delay for valve ${valveId} ch${channelId}: ${hours}h`);

            device._notifyStateChange('rain-delay-mqtt');

            device.sendPingTrigger(null, 2, 0x03).catch(err => {
                console.error(`[MQTT] Rain delay ping failed for valve ${valveId}: ${err.message}`);
            });

            return;
        }

        // --------------------------------------------------------
        // Channel Config: diivoo/{valveId}/ch/{channelId}/default_duration/set
        // --------------------------------------------------------
        if (parts.length === 6 && parts[0] === 'diivoo' && parts[2] === 'ch'
            && parts[4] === 'default_duration' && parts[5] === 'set') {
            const valveId = parseInt(parts[1], 10);
            const channelId = parseInt(parts[3], 10);
            const device = this.hub.devices.get(valveId);
            if (!device) return;

            const channel = device.channels?.[channelId];
            if (!channel) return;
            if (!channel.settings) {
                channel.settings = { durationSeconds: 600, intervalOnSeconds: 10, intervalOffSeconds: 30, rainDelayDate: null };
            }

            const value = Math.round(parseFloat(raw.trim()));
            if (!Number.isFinite(value) || value < 1 || value > 65535) {
                console.warn(`[MQTT] Invalid default_duration: ${raw}`);
                this.publishDeviceState({ valveId, state: device.getLiveState() });
                return;
            }

            channel.settings.durationSeconds = value;
            device._notifyStateChange('default-duration-mqtt');
            device.sendPingTrigger(null, 2, 0x03).catch(err => {
                console.error(`[MQTT] Config ping failed for valve ${valveId}: ${err.message}`);
            });
            return;
        }

        // --------------------------------------------------------
        // Channel Config: diivoo/{valveId}/ch/{channelId}/mist_on/set
        // --------------------------------------------------------
        if (parts.length === 6 && parts[0] === 'diivoo' && parts[2] === 'ch'
            && parts[4] === 'mist_on' && parts[5] === 'set') {
            const valveId = parseInt(parts[1], 10);
            const channelId = parseInt(parts[3], 10);
            const device = this.hub.devices.get(valveId);
            if (!device) return;

            const channel = device.channels?.[channelId];
            if (!channel) return;
            if (!channel.settings) {
                channel.settings = { durationSeconds: 600, intervalOnSeconds: 10, intervalOffSeconds: 30, rainDelayDate: null };
            }

            const value = Math.round(parseFloat(raw.trim()));
            if (!Number.isFinite(value) || value < 1 || value > 3600) {
                console.warn(`[MQTT] Invalid mist_on: ${raw}`);
                this.publishDeviceState({ valveId, state: device.getLiveState() });
                return;
            }

            channel.settings.intervalOnSeconds = value;
            device._notifyStateChange('mist-on-mqtt');
            device.sendPingTrigger(null, 2, 0x03).catch(err => {
                console.error(`[MQTT] Config ping failed for valve ${valveId}: ${err.message}`);
            });
            return;
        }

        // --------------------------------------------------------
        // Channel Config: diivoo/{valveId}/ch/{channelId}/mist_off/set
        // --------------------------------------------------------
        if (parts.length === 6 && parts[0] === 'diivoo' && parts[2] === 'ch'
            && parts[4] === 'mist_off' && parts[5] === 'set') {
            const valveId = parseInt(parts[1], 10);
            const channelId = parseInt(parts[3], 10);
            const device = this.hub.devices.get(valveId);
            if (!device) return;

            const channel = device.channels?.[channelId];
            if (!channel) return;
            if (!channel.settings) {
                channel.settings = { durationSeconds: 600, intervalOnSeconds: 10, intervalOffSeconds: 30, rainDelayDate: null };
            }

            const value = Math.round(parseFloat(raw.trim()));
            if (!Number.isFinite(value) || value < 1 || value > 3600) {
                console.warn(`[MQTT] Invalid mist_off: ${raw}`);
                this.publishDeviceState({ valveId, state: device.getLiveState() });
                return;
            }

            channel.settings.intervalOffSeconds = value;
            device._notifyStateChange('mist-off-mqtt');
            device.sendPingTrigger(null, 2, 0x03).catch(err => {
                console.error(`[MQTT] Config ping failed for valve ${valveId}: ${err.message}`);
            });
            return;
        }

        // --------------------------------------------------------
        // Schedules: diivoo/{valveId}/ch/{channelId}/schedules/set
        // --------------------------------------------------------
        if (parts.length === 6 && parts[0] === 'diivoo' && parts[2] === 'ch'
            && parts[4] === 'schedules' && parts[5] === 'set') {
            const valveId = parseInt(parts[1], 10);
            const channelId = parseInt(parts[3], 10);
            const device = this.hub.devices.get(valveId);
            if (!device) return;

            const channel = device.channels?.[channelId];
            if (!channel) return;

            const parsed = this._safeJsonParse(raw);
            if (!Array.isArray(parsed)) {
                console.warn(`[MQTT] Invalid schedules payload (not array): ${raw}`);
                this.publishDeviceState({ valveId, state: device.getLiveState() });
                this.publishScheduleAttributes(device);
                return;
            }

            let normalized;
            try {
                normalized = parsed.map(item => normalizeSchedule(item || {}));
            } catch (err) {
                console.warn(`[MQTT] Schedule normalization error: ${err.message}`);
                this.publishDeviceState({ valveId, state: device.getLiveState() });
                this.publishScheduleAttributes(device);
                return;
            }

            const otherCount = countTotalSchedules(device.channels, channelId);
            if (otherCount + normalized.length > 6) {
                console.warn(`[MQTT] Schedule limit exceeded: ${otherCount} existing + ${normalized.length} new > 6`);
                this.publishDeviceState({ valveId, state: device.getLiveState() });
                this.publishScheduleAttributes(device);
                return;
            }

            channel.schedules = normalized;
            device._notifyStateChange('schedules-mqtt');
            device.sendPingTrigger(null, 2, 0x03).catch(err => {
                console.error(`[MQTT] Config ping failed for valve ${valveId}: ${err.message}`);
            });
            return;
        }

        // --------------------------------------------------------
        // Valve Entity: diivoo/{valveId}/valve/{channelId}/cmd
        // --------------------------------------------------------
        if (parts.length === 5 && parts[0] === 'diivoo' && parts[2] === 'valve' && parts[4] === 'cmd') {
            const valveId = parseInt(parts[1], 10);
            const channelId = parseInt(parts[3], 10);
            const device = this.hub.devices.get(valveId);
            if (!device) return;

            const channel = device.channels?.[channelId];
            if (!channel) return;

            const trimmed = raw.trim();
            const upper = trimmed.toUpperCase();

            try {
                if (upper === 'CLOSE') {
                    await device.valve(channelId).off();
                    return;
                }

                if (upper === 'OPEN') {
                    const duration = channel.settings?.durationSeconds || 600;
                    await device.valve(channelId).on(duration);
                    return;
                }

                // Try parsing as JSON: {"command": "OPEN", "duration": 300}
                const parsedCmd = this._safeJsonParse(trimmed);
                if (parsedCmd && typeof parsedCmd === 'object') {
                    const cmd = String(parsedCmd.command || '').toUpperCase();
                    if (cmd === 'OPEN') {
                        const dur = Math.max(1, Math.min(65535,
                            Math.round(Number(parsedCmd.duration) || channel.settings?.durationSeconds || 600)
                        ));
                        await device.valve(channelId).on(dur);
                        return;
                    }
                    if (cmd === 'CLOSE') {
                        await device.valve(channelId).off();
                        return;
                    }
                }

                // Unrecognized payload — silently discard
            } catch (err) {
                console.error(`[MQTT] Valve cmd failed: ${err.message}`);
            }
            return;
        }

        // --------------------------------------------------------
        // Gateway LED: diivoo/gateway/{gatewayId}/led/set
        // HA light schema=json sendet i.d.R. {"state":"ON"} / {"state":"OFF"}
        // --------------------------------------------------------
        if (parts.length === 5 && parts[0] === 'diivoo' && parts[1] === 'gateway' && parts[3] === 'led' && parts[4] === 'set') {
            const gatewayId = parts[2];
            const desiredState = this._extractOnOff(raw);

            if (!desiredState) {
                console.warn(`[MQTT] Unknown LED payload for ${gatewayId}: ${raw}`);
                return;
            }

            try {
                await this.hub.setGatewayLed(gatewayId, desiredState === 'ON');

                const gwState = this._getGatewayState(gatewayId);
                gwState.ledState = desiredState;
                gwState.lastUpdateTs = Date.now();

                this.publishGatewayState(gatewayId);
            } catch (err) {
                console.error(`[MQTT] LED command failed (${gatewayId}): ${err.message}`);
            }

            return;
        }

        // --------------------------------------------------------
        // Gateway Portal: diivoo/gateway/{gatewayId}/portal/press
        // --------------------------------------------------------
        if (parts.length === 5 && parts[0] === 'diivoo' && parts[1] === 'gateway' && parts[3] === 'portal' && parts[4] === 'press') {
            const gatewayId = parts[2];

            try {
                await this.hub.startGatewayPortal(gatewayId);
            } catch (err) {
                console.error(`[MQTT] PORTAL command failed (${gatewayId}): ${err.message}`);
            }

            return;
        }

        // --------------------------------------------------------
        // Gateway ClearWiFi: diivoo/gateway/{gatewayId}/clearwifi/press
        // --------------------------------------------------------
        if (parts.length === 5 && parts[0] === 'diivoo' && parts[1] === 'gateway' && parts[3] === 'clearwifi' && parts[4] === 'press') {
            const gatewayId = parts[2];

            try {
                await this.hub.clearGatewayWifi(gatewayId);
            } catch (err) {
                console.error(`[MQTT] CLEARWIFI command failed (${gatewayId}): ${err.message}`);
            }

            return;
        }

        // --------------------------------------------------------
        // Gateway Version abfragen: diivoo/gateway/{gatewayId}/version/get
        // --------------------------------------------------------
        if (parts.length === 5 && parts[0] === 'diivoo' && parts[1] === 'gateway' && parts[3] === 'version' && parts[4] === 'get') {
            const gatewayId = parts[2];

            try {
                const gwNode = this._getGatewayNode(gatewayId);
                if (gwNode && gwNode.isConnected) {
                    gwNode.getVersion().catch(() => {});
                }
            } catch (err) {
                console.error(`[MQTT] VERSION GET failed (${gatewayId}): ${err.message}`);
            }

            return;
        }

        // --------------------------------------------------------
        // Gateway Update: diivoo/gateway/{gatewayId}/update/set
        // --------------------------------------------------------
        if (parts.length === 5 && parts[0] === 'diivoo' && parts[1] === 'gateway' && parts[3] === 'update' && parts[4] === 'set') {
            const gatewayId = parts[2];
            const messageStr = String(raw).trim();

            if (messageStr === 'INSTALL') {
                if (this.hub.otaManager) {
                    const port = process.env.WEB_PORT || 8099;
                    console.log(`[MQTT] Triggering OTA update for ${gatewayId} via Home Assistant`);
                    // in_progress / Status-Updates kommen jetzt über gatewayOtaStatus Events vom ESP32
                    this.hub.otaManager.triggerUpdate(gatewayId, null, port).catch(err => {
                        console.error(`[MQTT] OTA error: ${err.message}`);
                    });
                }
            }
            return;
        }
    }
}

module.exports = MqttBridge;