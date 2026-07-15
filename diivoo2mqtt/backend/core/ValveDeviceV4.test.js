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

const test = require('node:test');
const assert = require('node:assert/strict');
const ValveDevice = require('./ValveDeviceV4');

function createDevice(options = {}) {
    const mockGateway = { send: () => {} };
    return new ValveDevice(
        options.valveId ?? 12345,
        options.hubId ?? 99999,
        mockGateway,
        { channelCount: options.channelCount ?? 2, ...options }
    );
}

test('_computeBestRssi returns -100 when gatewayStats is empty', () => {
    const device = createDevice();
    assert.equal(device._computeBestRssi(), -100);
});

test('_computeBestRssi returns max RSSI from gatewayStats', () => {
    const device = createDevice();
    device.gatewayStats.set('gw1', { rssi: -80, lastSeen: Date.now() });
    device.gatewayStats.set('gw2', { rssi: -45, lastSeen: Date.now() });
    device.gatewayStats.set('gw3', { rssi: -60, lastSeen: Date.now() });
    assert.equal(device._computeBestRssi(), -45);
});

test('_computeBestRssi returns single RSSI when only one gateway', () => {
    const device = createDevice();
    device.gatewayStats.set('gw1', { rssi: -72, lastSeen: Date.now() });
    assert.equal(device._computeBestRssi(), -72);
});

test('getLiveState includes device-level fields', () => {
    const device = createDevice();
    device.firmwareVersion = 2;
    device.hardwareRevision = 7;
    device.gatewayStats.set('gw1', { rssi: -50, lastSeen: Date.now() });

    const state = device.getLiveState();

    assert.equal(state.firmwareVersion, 'v2');
    assert.equal(state.hardwareRevision, '7');
    assert.equal(state.bestRssi, -50);
});

test('getLiveState shows unknown firmware/hardware when null', () => {
    const device = createDevice();

    const state = device.getLiveState();

    assert.equal(state.firmwareVersion, 'unknown');
    assert.equal(state.hardwareRevision, 'unknown');
    assert.equal(state.bestRssi, -100);
});

test('getLiveState includes per-channel config fields with defaults', () => {
    const device = createDevice({ channelCount: 1 });

    const state = device.getLiveState();
    const ch = state.channels[1];

    assert.equal(ch.defaultOpenSeconds, 600);
    assert.equal(ch.intervalOnSeconds, 10);
    assert.equal(ch.intervalOffSeconds, 30);
    assert.equal(ch.scheduleCount, 0);
    assert.equal(ch.lastWaterConsumption, 0);
    assert.equal(ch.lastElapsedSeconds, 0);
    assert.equal(ch.lastEventDate, null);
});

test('getLiveState reflects custom channel settings', () => {
    const device = createDevice({ channelCount: 1 });
    device.channels[1].settings.durationSeconds = 1200;
    device.channels[1].settings.intervalOnSeconds = 20;
    device.channels[1].settings.intervalOffSeconds = 60;
    device.channels[1].schedules = [{ id: 'plan-1' }, { id: 'plan-2' }];
    device.channels[1].lastWaterConsumption = 500;
    device.channels[1].lastElapsedSeconds = 120;
    device.channels[1].lastEventDate = '2024-06-15T08:30:00';

    const state = device.getLiveState();
    const ch = state.channels[1];

    assert.equal(ch.defaultOpenSeconds, 1200);
    assert.equal(ch.intervalOnSeconds, 20);
    assert.equal(ch.intervalOffSeconds, 60);
    assert.equal(ch.scheduleCount, 2);
    assert.equal(ch.lastWaterConsumption, 500);
    assert.equal(ch.lastElapsedSeconds, 120);
    assert.equal(ch.lastEventDate, '2024-06-15T08:30:00');
});

test('getLiveState preserves existing fields (backward compatibility)', () => {
    const device = createDevice({ channelCount: 1 });
    device.channels[1].status = 'AN';
    device.channels[1].isRunning = true;
    device.channels[1].remaining = 300;
    device.channels[1].runtime = 600;
    device.channels[1].sourceText = 'user';
    device.channels[1].lastSyncTime = Date.now();
    device.lastSeen = Date.now();

    const state = device.getLiveState();
    const ch = state.channels[1];

    // Existing fields must still be present
    assert.ok('status' in ch);
    assert.ok('isRunning' in ch);
    assert.ok('remainingLive' in ch);
    assert.ok('targetRuntime' in ch);
    assert.ok('source' in ch);
    assert.ok('lastSync' in ch);
    assert.ok('rainDelayHours' in ch);
    assert.ok('rainDelayUntil' in ch);

    // Device-level existing fields
    assert.ok('valveId' in state);
    assert.ok('model' in state);
    assert.ok('alias' in state);
    assert.ok('battery' in state);
    assert.ok('batteryPercent' in state);
    assert.ok('isOnline' in state);
    assert.ok('gateways' in state);
    assert.ok('channels' in state);
});

test('getLiveState firmwareVersion formats 0 correctly', () => {
    const device = createDevice();
    device.firmwareVersion = 0;
    device.hardwareRevision = 0;

    const state = device.getLiveState();

    // 0 is not null, so it should format
    assert.equal(state.firmwareVersion, 'v0');
    assert.equal(state.hardwareRevision, '0');
});

// ─── Property-Based Tests ────────────────────────────────────────────────────
const fc = require('fast-check');

test('Property 7: bestRssi is maximum across gateways', () => {
    /**
     * Validates: Requirements 6.5, 14.3
     *
     * For any set of RSSI values in gatewayStats, bestRssi SHALL equal the
     * maximum RSSI value. If the map is empty, it SHALL be -100.
     */
    fc.assert(
        fc.property(
            fc.array(fc.integer({ min: -120, max: 0 }), { minLength: 0, maxLength: 10 }),
            (rssiValues) => {
                const device = createDevice();

                for (let i = 0; i < rssiValues.length; i++) {
                    device.gatewayStats.set(`gw${i}`, {
                        rssi: rssiValues[i],
                        lastSeen: Date.now(),
                    });
                }

                const result = device._computeBestRssi();

                if (rssiValues.length === 0) {
                    assert.equal(result, -100);
                } else {
                    assert.equal(result, Math.max(...rssiValues));
                }
            }
        ),
        { numRuns: 100 }
    );
});

test('Property 6: getLiveState backward compatibility', () => {
    /**
     * Validates: Requirements 6.3
     *
     * For any ValveDeviceV4 instance, getLiveState() SHALL always include
     * existing fields (status, isRunning, remainingLive, targetRuntime,
     * source, lastSync, rainDelayHours, rainDelayUntil) per channel.
     */
    fc.assert(
        fc.property(
            fc.integer({ min: 1, max: 4 }),
            (channelCount) => {
                const device = createDevice({ channelCount });

                const state = device.getLiveState();

                const expectedChannelFields = [
                    'status',
                    'isRunning',
                    'remainingLive',
                    'targetRuntime',
                    'source',
                    'lastSync',
                    'rainDelayHours',
                    'rainDelayUntil',
                ];

                for (let ch = 1; ch <= channelCount; ch++) {
                    const channelState = state.channels[ch];
                    assert.ok(
                        channelState,
                        `Channel ${ch} should exist in getLiveState() output`
                    );

                    for (const field of expectedChannelFields) {
                        assert.ok(
                            field in channelState,
                            `Channel ${ch} missing field: ${field}`
                        );
                    }
                }
            }
        ),
        { numRuns: 100 }
    );
});
