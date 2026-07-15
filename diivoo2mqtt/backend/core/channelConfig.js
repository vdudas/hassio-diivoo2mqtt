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

/**
 * Normalize a schedule object to canonical form.
 * Shared between webServer.js and mqttBridge.js for consistent validation.
 *
 * @param {object} schedule - Raw schedule input
 * @returns {object} Normalized schedule with validated fields
 * @throws {Error} If custom repeat has no weekdays selected
 */
function normalizeSchedule(schedule) {
    const mode = schedule.mode === 'mist' ? 'mist' : 'normal';
    const startTime = typeof schedule.startTime === 'string'
        && /^\d{2}:\d{2}$/.test(schedule.startTime)
        ? schedule.startTime : '06:00';

    // Max 1092 minutes = 65535 seconds (RF protocol LE16 limit)
    const durationMinutes = Math.max(1, Math.min(1092,
        Number(schedule.durationMinutes) || 10));
    const repeat = ['daily', 'odd', 'even', 'custom'].includes(schedule.repeat)
        ? schedule.repeat : 'daily';

    let weekdays = [];
    if (repeat === 'custom') {
        weekdays = Array.isArray(schedule.weekdays)
            ? Array.from(new Set(
                schedule.weekdays.map(Number)
                    .filter(day => day >= 1 && day <= 7)
            )).sort((a, b) => a - b)
            : [];
        if (weekdays.length === 0) {
            throw new Error(
                'At least one weekday required for custom repeat.'
            );
        }
    }

    const normalized = {
        id: schedule.id || `plan-${Date.now()}`,
        mode, startTime, durationMinutes, repeat, weekdays,
    };

    if (mode === 'mist') {
        normalized.mistOnSeconds = Math.max(1, Math.min(3600,
            Number(schedule.mistOnSeconds) || 10));
        normalized.mistOffSeconds = Math.max(1, Math.min(3600,
            Number(schedule.mistOffSeconds) || 30));
    }
    return normalized;
}

/**
 * Count total schedules across all channels of a device.
 *
 * @param {object} channels - Device channels object (keyed by channel id)
 * @param {number|null} excludeChannelId - Channel to exclude from count
 *   (the one being replaced)
 * @returns {number} Total schedule count across included channels
 */
function countTotalSchedules(channels, excludeChannelId = null) {
    let total = 0;
    for (const [chId, ch] of Object.entries(channels)) {
        if (Number(chId) === excludeChannelId) continue;
        total += Array.isArray(ch.schedules) ? ch.schedules.length : 0;
    }
    return total;
}

module.exports = { normalizeSchedule, countTotalSchedules };
