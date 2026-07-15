// ///////////////////////////////////////////////////////////////
// /                                                             /
// /                           NOTICE                            /
// /                                                             /
// /   THIS SOFTWARE IS THE PROPERTY OF AND CONTAINS             /
// /   CONFIDENTIAL INFORMATION OF INFOR AND/OR ITS AFFILIATES   /
// /   OR SUBSIDIARIES AND SHALL NOT BE DISCLOSED WITHOUT PRIOR  /
// /   WRITTEN PERMISSION. LICENSED CUSTOMERS MAY COPY AND       /
// /   ADAPT THIS SOFTWARE FOR THEIR OWN USE IN ACCORDANCE WITH  /
// /   THE TERMS OF THEIR SOFTWARE LICENSE AGREEMENT.            /
// /   ALL OTHER RIGHTS RESERVED.                                /
// /                                                             /
// /   (c) COPYRIGHT 2025 INFOR.  ALL RIGHTS RESERVED.           /
// /   THE WORD AND DESIGN MARKS SET FORTH HEREIN ARE            /
// /   TRADEMARKS AND/OR REGISTERED TRADEMARKS OF INFOR          /
// /   AND/OR ITS AFFILIATES AND SUBSIDIARIES. ALL RIGHTS        /
// /   RESERVED.  ALL OTHER TRADEMARKS LISTED HEREIN ARE         /
// /   THE PROPERTY OF THEIR RESPECTIVE OWNERS.                  /
// /                                                             /
// ///////////////////////////////////////////////////////////////

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const Module = require('module');

// ─── Mock mqtt module before requiring MqttBridge ────────────────────────────

const originalRequire = Module.prototype.require;
const mockClients = [];

Module.prototype.require = function (id) {
    if (id === 'mqtt') {
        return {
            connect: () => {
                const client = {
                    on: () => {},
                    subscribe: () => {},
                    publish: () => {},
                };
                mockClients.push(client);
                return client;
            },
        };
    }
    return originalRequire.apply(this, arguments);
};

const MqttBridge = require('./mqttBridge');

// Restore original require
Module.prototype.require = originalRequire;

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestBridge() {
    const publishCalls = [];
    const valveOnCalls = [];
    const valveOffCalls = [];
    const notifyCalls = [];
    const pingCalls = [];

    const channel = {
        settings: {
            durationSeconds: 600,
            intervalOnSeconds: 10,
            intervalOffSeconds: 30,
            rainDelayDate: null,
        },
        schedules: [],
        status: 'AUS',
        isRunning: false,
        remaining: 0,
        runtime: 600,
        sourceText: 'none',
        lastSyncTime: Date.now(),
    };

    const device = {
        valveId: 12345,
        model: 'WT-13W',
        alias: 'Test Valve',
        channelCount: 2,
        channels: {
            1: channel,
            2: {
                settings: {
                    durationSeconds: 600,
                    intervalOnSeconds: 10,
                    intervalOffSeconds: 30,
                    rainDelayDate: null,
                },
                schedules: [],
                status: 'AUS',
                isRunning: false,
                remaining: 0,
                runtime: 600,
                sourceText: 'none',
                lastSyncTime: Date.now(),
            },
        },
        getLiveState: () => ({
            valveId: 12345,
            model: 'WT-13W',
            alias: 'Test Valve',
            battery: 'OK',
            batteryPercent: 100,
            isOnline: true,
            firmwareVersion: 'v2',
            hardwareRevision: '7',
            bestRssi: -50,
            channels: {
                1: {
                    status: 'AUS',
                    isRunning: false,
                    remainingLive: 0,
                    targetRuntime: 600,
                    source: 'none / OFF',
                    defaultOpenSeconds: channel.settings.durationSeconds,
                    intervalOnSeconds: channel.settings.intervalOnSeconds,
                    intervalOffSeconds: channel.settings.intervalOffSeconds,
                    scheduleCount: channel.schedules.length,
                },
                2: {
                    status: 'AUS',
                    isRunning: false,
                    remainingLive: 0,
                    targetRuntime: 600,
                    source: 'none / OFF',
                    defaultOpenSeconds: 600,
                    intervalOnSeconds: 10,
                    intervalOffSeconds: 30,
                    scheduleCount: 0,
                },
            },
        }),
        _notifyStateChange: (reason) => notifyCalls.push(reason),
        sendPingTrigger: (...args) => {
            pingCalls.push(args);
            return Promise.resolve();
        },
        valve: (ch) => ({
            on: (seconds) => {
                valveOnCalls.push({ ch, seconds });
                return Promise.resolve();
            },
            off: () => {
                valveOffCalls.push({ ch });
                return Promise.resolve();
            },
        }),
    };

    const hub = {
        devices: new Map([[12345, device]]),
        on: () => {},
    };

    const config = {
        brokerUrl: 'mqtt://localhost',
        discoveryPrefix: 'homeassistant',
        language: 'en',
    };

    const bridge = new MqttBridge(hub, config);

    // Override _publish to track calls
    bridge._publish = (topic, payload, options) => {
        publishCalls.push({ topic, payload, options });
    };

    // Override publishDeviceState to track it
    const originalPublishDeviceState = bridge.publishDeviceState.bind(bridge);
    bridge.publishDeviceState = (updateData) => {
        publishCalls.push({
            topic: `diivoo/${updateData.valveId}/state`,
            payload: JSON.stringify(updateData.state),
            _isStateRepublish: true,
        });
    };

    // Override publishScheduleAttributes to track it
    bridge.publishScheduleAttributes = (dev) => {
        publishCalls.push({
            topic: `diivoo/${dev.valveId}/schedules-attributes`,
            _isScheduleRepublish: true,
        });
    };

    return {
        bridge,
        device,
        channel,
        hub,
        publishCalls,
        valveOnCalls,
        valveOffCalls,
        notifyCalls,
        pingCalls,
    };
}

// ─── Property-Based Tests ────────────────────────────────────────────────────

test('Property 1: Valid command updates are applied correctly', async () => {
    /**
     * Validates: Requirements 1.4, 2.4, 3.4
     *
     * For any valid numeric payload within the allowed range for a given
     * config field, sending that value to the corresponding command topic
     * SHALL result in the channel's settings reflecting exactly that value.
     */
    const fieldSpecs = [
        {
            field: 'durationSeconds',
            topicSegment: 'default_duration',
            min: 1,
            max: 65535,
        },
        {
            field: 'intervalOnSeconds',
            topicSegment: 'mist_on',
            min: 1,
            max: 3600,
        },
        {
            field: 'intervalOffSeconds',
            topicSegment: 'mist_off',
            min: 1,
            max: 3600,
        },
    ];

    for (const spec of fieldSpecs) {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: spec.min, max: spec.max }),
                async (value) => {
                    const { bridge, channel } = createTestBridge();

                    const topic = `diivoo/12345/ch/1/${spec.topicSegment}/set`;
                    const message = Buffer.from(String(value));

                    await bridge.handleIncomingMessage(topic, message);

                    assert.equal(
                        channel.settings[spec.field],
                        value,
                        `${spec.field} should be ${value} after sending ${value}`
                    );
                }
            ),
            { numRuns: 100 }
        );
    }
});

test('Property 2: Invalid payloads rejected without mutation', async () => {
    /**
     * Validates: Requirements 1.5, 2.5, 3.5
     *
     * For any payload that is NOT a finite number within valid range,
     * sending it SHALL leave channel settings unchanged AND trigger
     * a re-publish.
     */
    const fieldSpecs = [
        {
            field: 'durationSeconds',
            topicSegment: 'default_duration',
            min: 1,
            max: 65535,
            initialValue: 600,
        },
        {
            field: 'intervalOnSeconds',
            topicSegment: 'mist_on',
            min: 1,
            max: 3600,
            initialValue: 10,
        },
        {
            field: 'intervalOffSeconds',
            topicSegment: 'mist_off',
            min: 1,
            max: 3600,
            initialValue: 30,
        },
    ];

    // Generate invalid payloads: out-of-range numbers, non-numeric strings,
    // special values
    const invalidPayloadArb = fc.oneof(
        // Negative numbers
        fc.integer({ min: -100000, max: 0 }).map(String),
        // Out of range high (above 65535 covers all fields)
        fc.integer({ min: 65536, max: 1000000 }).map(String),
        // Non-numeric strings
        fc.constantFrom('abc', 'hello', 'xyz', 'foo', 'bar', 'test'),
        // Special float strings
        fc.constantFrom('NaN', 'Infinity', '-Infinity', '', '  ', 'null', 'undefined'),
    );

    for (const spec of fieldSpecs) {
        await fc.assert(
            fc.asyncProperty(
                invalidPayloadArb,
                async (invalidValue) => {
                    const { bridge, channel, publishCalls, notifyCalls }
                        = createTestBridge();

                    // Record the initial value
                    const initialValue = channel.settings[spec.field];

                    const topic = `diivoo/12345/ch/1/${spec.topicSegment}/set`;
                    const message = Buffer.from(String(invalidValue));

                    await bridge.handleIncomingMessage(topic, message);

                    // Setting should be unchanged
                    assert.equal(
                        channel.settings[spec.field],
                        initialValue,
                        `${spec.field} should remain ${initialValue} for invalid payload "${invalidValue}"`
                    );

                    // No state notification should have occurred
                    assert.equal(
                        notifyCalls.length,
                        0,
                        `_notifyStateChange should not be called for invalid payload "${invalidValue}"`
                    );

                    // A re-publish should have been triggered
                    const stateRepublish = publishCalls.some(
                        c => c._isStateRepublish
                    );
                    assert.ok(
                        stateRepublish,
                        `State re-publish should occur for invalid payload "${invalidValue}"`
                    );
                }
            ),
            { numRuns: 100 }
        );
    }
});

test('Property 11: Valve entity uses defaultOpenSeconds when no duration specified', async () => {
    /**
     * Validates: Requirements 16.6, 16.7
     *
     * For any random defaultOpenSeconds (1–65535), when an OPEN payload is
     * sent without a duration, the valve .on() SHALL be called with that value.
     */
    await fc.assert(
        fc.asyncProperty(
            fc.integer({ min: 1, max: 65535 }),
            async (defaultSeconds) => {
                const { bridge, channel, valveOnCalls } = createTestBridge();

                // Set the channel's default duration
                channel.settings.durationSeconds = defaultSeconds;

                const topic = 'diivoo/12345/valve/1/cmd';
                const message = Buffer.from('OPEN');

                await bridge.handleIncomingMessage(topic, message);

                assert.equal(valveOnCalls.length, 1, 'valve.on() should be called once');
                assert.equal(
                    valveOnCalls[0].seconds,
                    defaultSeconds,
                    `valve.on() should be called with ${defaultSeconds}`
                );
                assert.equal(valveOnCalls[0].ch, 1, 'valve.on() should target channel 1');
            }
        ),
        { numRuns: 100 }
    );
});

test('Property 12: Invalid commands trigger state re-publish', async () => {
    /**
     * Validates: Requirements 1.5, 2.5, 3.5, 5.5, 5.6
     *
     * For any invalid payload for each command type, assert re-publish
     * with pre-mutation state is called.
     */

    // Invalid payloads for numeric commands
    const invalidNumericArb = fc.oneof(
        fc.integer({ min: -100000, max: 0 }),
        fc.integer({ min: 65536, max: 1000000 }),
        fc.constantFrom('NaN', 'Infinity', '-Infinity', 'abc', '', 'null'),
    );

    // Test numeric commands (default_duration, mist_on, mist_off)
    const numericTopics = [
        'diivoo/12345/ch/1/default_duration/set',
        'diivoo/12345/ch/1/mist_on/set',
        'diivoo/12345/ch/1/mist_off/set',
    ];

    for (const topic of numericTopics) {
        await fc.assert(
            fc.asyncProperty(
                invalidNumericArb,
                async (invalidValue) => {
                    const { bridge, channel, publishCalls, notifyCalls }
                        = createTestBridge();

                    // Snapshot pre-mutation state
                    const preDuration = channel.settings.durationSeconds;
                    const preIntervalOn = channel.settings.intervalOnSeconds;
                    const preIntervalOff = channel.settings.intervalOffSeconds;

                    const message = Buffer.from(String(invalidValue));
                    await bridge.handleIncomingMessage(topic, message);

                    // No mutation occurred
                    assert.equal(channel.settings.durationSeconds, preDuration);
                    assert.equal(channel.settings.intervalOnSeconds, preIntervalOn);
                    assert.equal(channel.settings.intervalOffSeconds, preIntervalOff);

                    // No state notification
                    assert.equal(notifyCalls.length, 0);

                    // Re-publish was triggered
                    assert.ok(
                        publishCalls.some(c => c._isStateRepublish),
                        `State re-publish expected for invalid "${invalidValue}" on ${topic}`
                    );
                }
            ),
            { numRuns: 100 }
        );
    }

    // Test invalid schedule payloads (not JSON, not array)
    const invalidScheduleArb = fc.oneof(
        // Non-JSON strings
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => {
            try { JSON.parse(s); return false; } catch { return true; }
        }),
        // Valid JSON but not an array (objects, numbers, strings, booleans)
        fc.oneof(
            fc.integer().map(n => JSON.stringify(n)),
            fc.constant('{}'),
            fc.constant('"hello"'),
            fc.constant('true'),
            fc.constant('null'),
        ),
    );

    await fc.assert(
        fc.asyncProperty(
            invalidScheduleArb,
            async (invalidPayload) => {
                const { bridge, channel, publishCalls, notifyCalls }
                    = createTestBridge();

                const preSchedules = [...channel.schedules];

                const topic = 'diivoo/12345/ch/1/schedules/set';
                const message = Buffer.from(invalidPayload);

                await bridge.handleIncomingMessage(topic, message);

                // Schedules unchanged
                assert.deepEqual(channel.schedules, preSchedules);

                // No state notification
                assert.equal(notifyCalls.length, 0);

                // Re-publish triggered (both state and schedule attributes)
                assert.ok(
                    publishCalls.some(c => c._isStateRepublish),
                    `State re-publish expected for invalid schedule payload "${invalidPayload}"`
                );
                assert.ok(
                    publishCalls.some(c => c._isScheduleRepublish),
                    `Schedule attributes re-publish expected for invalid payload "${invalidPayload}"`
                );
            }
        ),
        { numRuns: 100 }
    );
});
