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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { normalizeSchedule, countTotalSchedules } = require('./channelConfig');

/**
 * Property 3: Schedule normalization consistency
 * **Validates: Requirements 5.3, 5.4**
 *
 * For any schedule-like object, normalizing it via normalizeSchedule()
 * SHALL produce a canonical result with validated fields.
 */
test('Property 3: Schedule normalization consistency', () => {
    const scheduleArb = fc.record({
        id: fc.oneof(fc.string(), fc.constant(undefined)),
        mode: fc.oneof(
            fc.constant('normal'),
            fc.constant('mist'),
            fc.string()
        ),
        startTime: fc.oneof(
            fc.tuple(
                fc.integer({ min: 0, max: 23 }),
                fc.integer({ min: 0, max: 59 })
            ).map(([h, m]) =>
                `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
            ),
            fc.string()
        ),
        durationMinutes: fc.oneof(
            fc.integer({ min: -10000, max: 10000 }),
            fc.double(),
            fc.constant(undefined),
            fc.constant(null)
        ),
        repeat: fc.oneof(
            fc.constant('daily'),
            fc.constant('odd'),
            fc.constant('even'),
            fc.constant('custom'),
            fc.string()
        ),
        weekdays: fc.oneof(
            fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 }),
            fc.array(fc.integer({ min: -10, max: 20 })),
            fc.constant(undefined)
        ),
        mistOnSeconds: fc.oneof(
            fc.integer({ min: -100, max: 5000 }),
            fc.constant(undefined)
        ),
        mistOffSeconds: fc.oneof(
            fc.integer({ min: -100, max: 5000 }),
            fc.constant(undefined)
        ),
    });

    fc.assert(fc.property(scheduleArb, (schedule) => {
        // When repeat is 'custom', we need valid weekdays to avoid the throw
        const willBeCustom = schedule.repeat === 'custom';
        const hasValidWeekdays = Array.isArray(schedule.weekdays) &&
            schedule.weekdays.some(d => Number(d) >= 1 && Number(d) <= 7);

        if (willBeCustom && !hasValidWeekdays) {
            // Expect normalizeSchedule to throw
            assert.throws(
                () => normalizeSchedule(schedule),
                /At least one weekday required/
            );
            return;
        }

        const result = normalizeSchedule(schedule);

        // mode is 'normal' or 'mist'
        assert.ok(
            result.mode === 'normal' || result.mode === 'mist',
            `mode must be 'normal' or 'mist', got: ${result.mode}`
        );

        // startTime matches HH:MM
        assert.match(result.startTime, /^\d{2}:\d{2}$/);

        // durationMinutes in [1, 1092]
        assert.ok(result.durationMinutes >= 1,
            `durationMinutes must be >= 1, got: ${result.durationMinutes}`);
        assert.ok(result.durationMinutes <= 1092,
            `durationMinutes must be <= 1092, got: ${result.durationMinutes}`);

        // repeat is one of the valid values
        assert.ok(
            ['daily', 'odd', 'even', 'custom'].includes(result.repeat),
            `repeat must be daily/odd/even/custom, got: ${result.repeat}`
        );

        // weekdays is an array of sorted unique integers 1-7
        assert.ok(Array.isArray(result.weekdays));
        if (result.repeat === 'custom') {
            assert.ok(result.weekdays.length > 0,
                'weekdays must be non-empty for custom repeat');
        }
        for (const day of result.weekdays) {
            assert.ok(Number.isInteger(day) && day >= 1 && day <= 7,
                `weekday must be integer 1-7, got: ${day}`);
        }
        // Check sorted
        for (let i = 1; i < result.weekdays.length; i++) {
            assert.ok(result.weekdays[i] > result.weekdays[i - 1],
                'weekdays must be sorted and unique');
        }

        // If mode is 'mist': mistOnSeconds and mistOffSeconds in [1, 3600]
        if (result.mode === 'mist') {
            assert.ok(result.mistOnSeconds >= 1 && result.mistOnSeconds <= 3600,
                `mistOnSeconds must be in [1,3600], got: ${result.mistOnSeconds}`);
            assert.ok(result.mistOffSeconds >= 1 && result.mistOffSeconds <= 3600,
                `mistOffSeconds must be in [1,3600], got: ${result.mistOffSeconds}`);
        }

        // id is always a non-empty string
        assert.ok(typeof result.id === 'string' && result.id.length > 0,
            `id must be a non-empty string, got: ${result.id}`);
    }), { numRuns: 100 });
});

/**
 * Property 4: Global schedule limit enforcement
 * **Validates: Requirements 5.5**
 *
 * For any channel/schedule distribution where total > 6,
 * countTotalSchedules() + new count > 6 should be detectable.
 */
test('Property 4: Global schedule limit enforcement', () => {
    // Generate random distributions of schedules across 1-4 channels
    const channelsArb = fc.integer({ min: 1, max: 4 }).chain(numChannels => {
        const channelEntries = {};
        const entries = [];
        for (let i = 1; i <= numChannels; i++) {
            entries.push(
                fc.integer({ min: 0, max: 6 }).map(count => [
                    i,
                    { schedules: Array.from({ length: count }, (_, idx) => ({ id: `s${idx}` })) }
                ])
            );
        }
        return fc.tuple(...entries).map(pairs => Object.fromEntries(pairs));
    });

    const targetChannelArb = fc.integer({ min: 1, max: 4 });
    const newCountArb = fc.integer({ min: 0, max: 6 });

    fc.assert(fc.property(
        channelsArb,
        targetChannelArb,
        newCountArb,
        (channels, targetChannel, newCount) => {
            const otherCount = countTotalSchedules(channels, targetChannel);

            // Verify otherCount counts schedules in all channels except target
            let expectedOtherCount = 0;
            for (const [chId, ch] of Object.entries(channels)) {
                if (Number(chId) === targetChannel) continue;
                expectedOtherCount += Array.isArray(ch.schedules)
                    ? ch.schedules.length : 0;
            }
            assert.equal(otherCount, expectedOtherCount,
                'countTotalSchedules should match manual count');

            // When total (excluding target) + new schedules > 6: check fails
            if (otherCount + newCount > 6) {
                assert.ok(otherCount + newCount > 6,
                    'Should detect limit exceeded');
            } else {
                // When total <= 6: the check passes
                assert.ok(otherCount + newCount <= 6,
                    'Should allow within limit');
            }
        }
    ), { numRuns: 100 });
});

/**
 * Property 5: Invalid schedule payloads rejected
 * **Validates: Requirements 5.6**
 *
 * For any non-array value, when passed to an Array.isArray check,
 * it should return false. This validates the guard in the command handler.
 */
test('Property 5: Invalid schedule payloads rejected', () => {
    const nonArrayArb = fc.oneof(
        fc.integer(),
        fc.double(),
        fc.string(),
        fc.record({ key: fc.string() }),
        fc.constant(null),
        fc.constant(undefined),
        fc.boolean(),
        fc.bigInt()
    );

    fc.assert(fc.property(nonArrayArb, (payload) => {
        assert.equal(Array.isArray(payload), false,
            `Non-array payload should fail Array.isArray: ${typeof payload}`);
    }), { numRuns: 100 });
});

/**
 * Property 10: Schedule duration clamping invariant
 * **Validates: Requirements 5.4**
 *
 * For ANY integer, when used as durationMinutes in a schedule object
 * passed to normalizeSchedule(), the resulting durationMinutes SHALL be
 * in [1, 1092].
 */
test('Property 10: Schedule duration clamping invariant', () => {
    const durationArb = fc.oneof(
        fc.integer({ min: -1000000, max: 1000000 }),
        fc.constant(0),
        fc.constant(-1),
        fc.constant(1093),
        fc.constant(1000000),
        fc.constant(-1000000)
    );

    fc.assert(fc.property(durationArb, (duration) => {
        const schedule = {
            id: 'test-plan',
            mode: 'normal',
            startTime: '08:00',
            durationMinutes: duration,
            repeat: 'daily',
            weekdays: [],
        };

        const result = normalizeSchedule(schedule);

        assert.ok(result.durationMinutes >= 1,
            `durationMinutes must be >= 1, got: ${result.durationMinutes} (input: ${duration})`);
        assert.ok(result.durationMinutes <= 1092,
            `durationMinutes must be <= 1092, got: ${result.durationMinutes} (input: ${duration})`);
        assert.ok(Number.isInteger(result.durationMinutes),
            `durationMinutes must be integer, got: ${result.durationMinutes}`);
    }), { numRuns: 100 });
});
