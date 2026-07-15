# Requirements Document

## Introduction

This feature exposes all per-channel valve configuration properties via MQTT discovery, matching the data already surfaced by the web UI through `_serializeChannelConfig()`. This includes default watering duration, misting interval settings, and irrigation schedules. The goal is to allow Home Assistant users to view and control these settings through standard HA entities and custom Lovelace cards, without needing the add-on's web UI.

## Glossary

- **MQTT_Bridge**: The `MqttBridge` class that manages MQTT connections, publishes Home Assistant discovery messages, state updates, and handles incoming command messages.
- **Valve_Device**: A `ValveDevice` instance representing a physical Diivoo irrigation valve with one or more channels.
- **Channel**: A single irrigation output on a Valve_Device, identified by a numeric index (1-based).
- **Channel_Config**: The set of configurable properties for a Channel: default open duration, misting on-time, misting off-interval, and schedules.
- **Schedule**: A single irrigation schedule object containing id, mode, startTime, durationMinutes, repeat pattern, weekdays, and optional mist parameters.
- **Discovery_Prefix**: The MQTT topic prefix used for Home Assistant MQTT discovery (default: `homeassistant`).
- **Number_Entity**: A Home Assistant entity type that represents a settable numeric value with min/max/step constraints.
- **JSON_Sensor**: A Home Assistant sensor entity that publishes structured JSON data via `json_attributes_topic`.
- **Command_Topic**: An MQTT topic that accepts payloads from Home Assistant to modify device configuration.
- **Diagnostic_Sensor**: A Home Assistant sensor entity with entity_category `diagnostic`, used to expose read-only device telemetry and metadata.

## Requirements

### Requirement 1: Default Duration Number Entity

**User Story:** As a Home Assistant user, I want to view and set the default watering duration for each valve channel via MQTT, so that I can configure irrigation timing without using the web UI.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a Number_Entity discovery message for each Channel with unique_id `diivoo_{valveId}_default_duration_{ch}`.
2. THE Number_Entity SHALL have a minimum value of 1, a maximum value of 65535, a step of 1, and unit_of_measurement of "s".
3. THE Number_Entity SHALL read its current value from the device state topic using a value_template that extracts `defaultOpenSeconds` for the Channel.
4. WHEN a numeric payload is received on the command topic `diivoo/{valveId}/ch/{ch}/default_duration/set`, THE MQTT_Bridge SHALL update the Channel settings `durationSeconds` to the received value.
5. IF the received payload is not a finite number between 1 and 65535 inclusive, THEN THE MQTT_Bridge SHALL log a warning, discard the command, and re-publish the current device state to the state topic so that the HA UI reflects the actual value.
6. WHEN the Channel_Config is updated via the command topic, THE MQTT_Bridge SHALL trigger a device state notification so the new value is published on the state topic.
7. WHEN the Channel_Config is updated via the command topic, THE MQTT_Bridge SHALL send a config-refresh ping (0x20/0x03) to the Valve_Device so the device pulls the updated parameters from the hub.

### Requirement 2: Misting On-Time Number Entity

**User Story:** As a Home Assistant user, I want to view and set the misting on-time for each valve channel via MQTT, so that I can fine-tune misting behavior remotely.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a Number_Entity discovery message for each Channel with unique_id `diivoo_{valveId}_mist_on_{ch}`.
2. THE Number_Entity SHALL have a minimum value of 1, a maximum value of 3600, a step of 1, and unit_of_measurement of "s". The 3600s application-level cap is a UX constraint; the RF protocol (LE16) supports up to 65535s.
3. THE Number_Entity SHALL read its current value from the device state topic using a value_template that extracts `intervalOnSeconds` for the Channel.
4. WHEN a numeric payload is received on the command topic `diivoo/{valveId}/ch/{ch}/mist_on/set`, THE MQTT_Bridge SHALL update the Channel settings `intervalOnSeconds` to the received value.
5. IF the received payload is not a finite number between 1 and 3600 inclusive, THEN THE MQTT_Bridge SHALL log a warning, discard the command, and re-publish the current device state to the state topic so that the HA UI reflects the actual value.
6. WHEN the Channel_Config is updated via the command topic, THE MQTT_Bridge SHALL trigger a device state notification so the new value is published on the state topic.
7. WHEN the Channel_Config is updated via the command topic, THE MQTT_Bridge SHALL send a config-refresh ping (0x20/0x03) to the Valve_Device so the device pulls the updated parameters from the hub.

### Requirement 3: Misting Off-Interval Number Entity

**User Story:** As a Home Assistant user, I want to view and set the misting off-interval for each valve channel via MQTT, so that I can control the pause between misting cycles.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a Number_Entity discovery message for each Channel with unique_id `diivoo_{valveId}_mist_off_{ch}`.
2. THE Number_Entity SHALL have a minimum value of 1, a maximum value of 3600, a step of 1, and unit_of_measurement of "s". The 3600s application-level cap is a UX constraint; the RF protocol (LE16) supports up to 65535s.
3. THE Number_Entity SHALL read its current value from the device state topic using a value_template that extracts `intervalOffSeconds` for the Channel.
4. WHEN a numeric payload is received on the command topic `diivoo/{valveId}/ch/{ch}/mist_off/set`, THE MQTT_Bridge SHALL update the Channel settings `intervalOffSeconds` to the received value.
5. IF the received payload is not a finite number between 1 and 3600 inclusive, THEN THE MQTT_Bridge SHALL log a warning, discard the command, and re-publish the current device state to the state topic so that the HA UI reflects the actual value.
6. WHEN the Channel_Config is updated via the command topic, THE MQTT_Bridge SHALL trigger a device state notification so the new value is published on the state topic.
7. WHEN the Channel_Config is updated via the command topic, THE MQTT_Bridge SHALL send a config-refresh ping (0x20/0x03) to the Valve_Device so the device pulls the updated parameters from the hub.

### Requirement 4: Schedules JSON Sensor

**User Story:** As a Home Assistant user, I want to view the irrigation schedules for each valve channel as a sensor with JSON attributes, so that I can display schedule data in custom Lovelace cards.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a JSON_Sensor discovery message for each Channel with unique_id `diivoo_{valveId}_schedules_{ch}`.
2. THE JSON_Sensor state SHALL display the number of schedules configured for the Channel (e.g., "2 schedules" or "0 schedules").
3. THE JSON_Sensor SHALL include a `json_attributes_topic` set to `diivoo/{valveId}/ch/{ch}/schedules/attributes`.
4. WHEN device state is published, THE MQTT_Bridge SHALL publish the full schedules array as a JSON object on the `json_attributes_topic` with key `schedules`.
5. THE MQTT_Bridge SHALL publish the schedules attributes topic with retain flag set to true.

### Requirement 5: Schedules Command Topic

**User Story:** As a Home Assistant user, I want to replace all schedules for a valve channel by publishing a JSON array to a command topic, so that I can manage irrigation schedules from a custom Lovelace card.

#### Acceptance Criteria

1. THE MQTT_Bridge SHALL subscribe to the command topic `diivoo/+/ch/+/schedules/set`.
2. WHEN a JSON array payload is received on `diivoo/{valveId}/ch/{ch}/schedules/set`, THE MQTT_Bridge SHALL replace all schedules for the specified Channel with the received array.
3. THE MQTT_Bridge SHALL normalize each schedule object in the received array using the same validation logic as `_normalizeSchedule` in the web server (enforcing valid mode, startTime format, durationMinutes range, repeat pattern, and weekdays).
4. IF any schedule in the received array has a `durationMinutes` value greater than 1092 or less than 1, THEN THE MQTT_Bridge SHALL clamp the value to the valid range (minimum 1, maximum 1092) and log a warning. The command SHALL NOT be rejected for out-of-range duration values. This limit exists because the RF protocol encodes schedule duration as LE16 seconds (max 65535 seconds = 1092 minutes).
5. IF the total number of schedules across all channels of the Valve_Device would exceed 6 after applying the update, THEN THE MQTT_Bridge SHALL reject the command, log a warning, leave the existing schedules unchanged, and re-publish the current device state and schedules attributes to their respective topics so that the HA UI reflects the actual values.
6. IF the payload is not valid JSON or not an array, THEN THE MQTT_Bridge SHALL log a warning, discard the command, and re-publish the current device state and schedules attributes to their respective topics so that the HA UI reflects the actual values.
7. WHEN schedules are successfully updated, THE MQTT_Bridge SHALL trigger a device state notification and republish the schedules attributes topic.
8. WHEN schedules are successfully updated, THE MQTT_Bridge SHALL send a config-refresh ping to the Valve_Device so the device pulls the updated configuration.

### Requirement 6: State Topic Extension

**User Story:** As a Home Assistant user, I want the device state topic to include channel configuration data, so that all number entities and sensors can read their values from a single state topic.

#### Acceptance Criteria

1. WHEN device state is published on `diivoo/{valveId}/state`, THE MQTT_Bridge SHALL include `defaultOpenSeconds`, `intervalOnSeconds`, `intervalOffSeconds`, `lastWaterConsumption` (integer, mL), `lastElapsedSeconds` (integer, seconds), and `lastEventDate` (string, ISO timestamp or null) for each Channel in the channels object.
2. WHEN device state is published, THE MQTT_Bridge SHALL include `scheduleCount` (integer) for each Channel in the channels object.
3. THE existing channel state fields (isRunning, remainingLive, targetRuntime, source, rainDelayHours, rainDelayUntil) SHALL remain unchanged in the state payload.
4. WHEN device state is published on `diivoo/{valveId}/state`, THE state payload SHALL include `firmwareVersion` (string) and `hardwareRevision` (string) at the device level (not per-channel).
5. WHEN device state is published, THE state payload SHALL include a `bestRssi` (integer, dBm) field at the device level, computed in `getLiveState()` as the maximum (closest to 0) RSSI value across all entries in the device's `gatewayStats` map. If no gateway stats exist, the value SHALL be -100.
6. THE ValveDevice `getLiveState()` method SHALL be extended to include `lastWaterConsumption` (integer, mL or 0 if unavailable), `lastElapsedSeconds` (integer, seconds or 0), and `lastEventDate` (string, ISO timestamp or null) for each Channel, and `firmwareVersion` (string), `hardwareRevision` (string), and `bestRssi` (integer, dBm) at the device level. These fields are already stored on the device model but are not currently included in the live state output.

### Requirement 7: Discovery Cleanup on Reconnect

**User Story:** As a Home Assistant user, I want discovery messages to be re-published when the MQTT bridge reconnects, so that channel config entities are always registered in Home Assistant.

#### Acceptance Criteria

1. WHEN the MQTT_Bridge reconnects to the broker, THE MQTT_Bridge SHALL republish all channel config discovery messages (Number_Entities and JSON_Sensor) along with existing valve and gateway discovery.
2. THE discovery messages SHALL be published with the retain flag set to true.

### Requirement 8: Command Topic Subscriptions

**User Story:** As a developer, I want the MQTT bridge to subscribe to all new command topics on connect, so that incoming configuration commands are received immediately.

#### Acceptance Criteria

1. WHEN the MQTT_Bridge connects to the broker, THE MQTT_Bridge SHALL subscribe to `diivoo/+/ch/+/default_duration/set`.
2. WHEN the MQTT_Bridge connects to the broker, THE MQTT_Bridge SHALL subscribe to `diivoo/+/ch/+/mist_on/set`.
3. WHEN the MQTT_Bridge connects to the broker, THE MQTT_Bridge SHALL subscribe to `diivoo/+/ch/+/mist_off/set`.
4. WHEN the MQTT_Bridge connects to the broker, THE MQTT_Bridge SHALL subscribe to `diivoo/+/ch/+/schedules/set`.
5. WHEN the MQTT_Bridge connects to the broker, THE MQTT_Bridge SHALL subscribe to `diivoo/+/valve/+/cmd`.

### Requirement 9: Water Consumption Sensor

**User Story:** As a Home Assistant user, I want to see the water consumption from the last watering session for each valve channel, so that I can track water usage.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a sensor discovery message for each Channel with unique_id `diivoo_{valveId}_water_consumption_{ch}`.
2. THE sensor SHALL have device_class `water`, unit_of_measurement `mL`, and state_class `measurement`.
3. THE sensor SHALL read its value from the device state topic using a value_template that extracts `lastWaterConsumption` for the Channel.
4. THE sensor SHALL have entity_category `diagnostic`.

### Requirement 10: Last Run Duration Sensor

**User Story:** As a Home Assistant user, I want to see how long the last watering session actually ran for each channel, so that I can verify irrigation timing.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a sensor discovery message for each Channel with unique_id `diivoo_{valveId}_last_duration_{ch}`.
2. THE sensor SHALL have device_class `duration`, unit_of_measurement `s`.
3. THE sensor SHALL read its value from the device state topic using a value_template that extracts `lastElapsedSeconds` for the Channel.
4. THE sensor SHALL have entity_category `diagnostic`.

### Requirement 11: Last Watering Event Timestamp Sensor

**User Story:** As a Home Assistant user, I want to see when the last watering session ended for each channel, so that I can monitor irrigation history.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a sensor discovery message for each Channel with unique_id `diivoo_{valveId}_last_event_{ch}`.
2. THE sensor SHALL have device_class `timestamp`.
3. THE sensor SHALL read its value from the device state topic using a value_template that extracts `lastEventDate` for the Channel.
4. THE sensor SHALL have entity_category `diagnostic`.

### Requirement 12: Firmware Version Sensor

**User Story:** As a Home Assistant user, I want to see the firmware version of each valve device, so that I can identify devices that may need updates.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a sensor discovery message with unique_id `diivoo_{valveId}_firmware`.
2. THE sensor state SHALL display the firmware version byte as a version string (e.g., "v2" for firmware byte 0x02).
3. THE sensor SHALL read its value from the device state topic using a value_template that extracts `firmwareVersion`.
4. THE sensor SHALL have entity_category `diagnostic` and icon `mdi:chip`.

### Requirement 13: Hardware Revision Sensor

**User Story:** As a Home Assistant user, I want to see the hardware revision of each valve device for diagnostic purposes.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a sensor discovery message with unique_id `diivoo_{valveId}_hw_revision`.
2. THE sensor state SHALL display the hardware revision byte as a string (e.g., "7" for revision byte 0x07).
3. THE sensor SHALL read its value from the device state topic using a value_template that extracts `hardwareRevision`.
4. THE sensor SHALL have entity_category `diagnostic` and icon `mdi:information-outline`.

### Requirement 14: RSSI Sensor

**User Story:** As a Home Assistant user, I want to see the RF signal strength between the valve and the gateway, so that I can diagnose connectivity issues.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a sensor discovery message with unique_id `diivoo_{valveId}_rssi`.
2. THE sensor SHALL have device_class `signal_strength`, unit_of_measurement `dBm`, and entity_category `diagnostic`.
3. THE sensor SHALL read its value from the device state topic using a value_template that extracts the best (highest) RSSI value from the `gateways` object.
4. THE sensor value SHALL update whenever a new packet is received from the valve on any gateway.

### Requirement 15: Target Runtime Sensor

**User Story:** As a Home Assistant user, I want to see the target (requested) duration for the current or last watering run, so that I can compare it against the actual duration.

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a sensor discovery message for each Channel with unique_id `diivoo_{valveId}_target_runtime_{ch}`.
2. THE sensor SHALL have device_class `duration`, unit_of_measurement `s`.
3. THE sensor SHALL read its value from the device state topic using a value_template that extracts `targetRuntime` for the Channel.
4. THE sensor SHALL have entity_category `diagnostic`.

### Requirement 16: Valve Entity (Water)

**User Story:** As a Home Assistant user, I want each valve channel represented as a native HA `valve` entity with `device_class: water`, so that I get proper irrigation iconography and can use the valve in HA automations that expect valve entities (e.g., water dashboards).

#### Acceptance Criteria

1. WHEN a Valve_Device is discovered, THE MQTT_Bridge SHALL publish a valve discovery message for each Channel with unique_id `diivoo_{valveId}_valve_{ch}`.
2. THE valve entity SHALL have `device_class` set to `water` and `reports_position` set to `false`.
3. THE valve entity state SHALL report `open` when the Channel's `isRunning` is true, and `closed` when `isRunning` is false.
4. THE valve entity SHALL use the state_topic `diivoo/{valveId}/state` with a value_template that maps `isRunning` to `open`/`closed`.
5. THE valve entity SHALL use a command_topic `diivoo/{valveId}/valve/{ch}/cmd` that accepts payloads `OPEN`, `CLOSE`, and JSON `{"command": "OPEN", "duration": <seconds>}`.
6. WHEN an `OPEN` payload is received without a duration, THE MQTT_Bridge SHALL open the valve using the Channel's current `defaultOpenSeconds` setting.
7. WHEN an `OPEN` payload with a JSON duration is received, THE MQTT_Bridge SHALL open the valve for the specified duration in seconds (clamped to 1–65535).
8. WHEN a `CLOSE` payload is received, THE MQTT_Bridge SHALL close the valve.
9. THE existing switch entity (`diivoo_{valveId}_valve_{ch}`) SHALL remain unchanged and continue to function as before.
10. THE MQTT_Bridge SHALL subscribe to `diivoo/+/valve/+/cmd` on connect.
