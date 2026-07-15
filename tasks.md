# Implementation Plan: MQTT Channel Config Exposure

## Overview

Extend the MQTT bridge to expose per-channel valve configuration (default duration, misting parameters, schedules), a native HA valve entity, and device-level diagnostics as Home Assistant entities via MQTT discovery. Implementation uses JavaScript (Node.js), matching the existing codebase.

## Tasks

- [x] 1. Create shared utility module and refactor webServer
  - [x] 1.1 Create `core/channelConfig.js` shared utility module
    - Create new file `diivoo2mqtt/backend/core/channelConfig.js`
    - Extract `normalizeSchedule()` function from `webServer.js._normalizeSchedule()` with the design's clamping range (1–1092 for durationMinutes)
    - Implement `countTotalSchedules(channels, excludeChannelId)` helper
    - Export both functions via `module.exports`
    - _Requirements: 5.3, 5.4, 5.5_

  - [x] 1.2 Refactor `webServer.js` to use shared `channelConfig.js`
    - Add `const { normalizeSchedule } = require('../core/channelConfig');` at top of webServer.js
    - Replace all calls to `this._normalizeSchedule(...)` with `normalizeSchedule(...)`
    - Remove the `_normalizeSchedule` method from the WebServer class
    - Verify no behavior change (existing Socket.IO schedule logic still works)
    - _Requirements: 5.3_

- [x] 2. Extend ValveDeviceV4 getLiveState
  - [x] 2.1 Add `_computeBestRssi()` method and extend `getLiveState()` in `ValveDeviceV4.js`
    - Add `_computeBestRssi()` helper: returns max RSSI from `this.gatewayStats` values, or -100 if empty
    - Extend per-channel output in `getLiveState()` with: `defaultOpenSeconds`, `intervalOnSeconds`, `intervalOffSeconds`, `scheduleCount`, `lastWaterConsumption`, `lastElapsedSeconds`, `lastEventDate`
    - Add device-level fields to return object: `firmwareVersion`, `hardwareRevision`, `bestRssi`
    - Ensure all existing fields remain unchanged (backward compatibility)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 2.2 Write property tests for `_computeBestRssi()` and `getLiveState()` extensions
    - **Property 7: bestRssi is maximum across gateways**
    - **Property 6: getLiveState backward compatibility**
    - **Validates: Requirements 6.3, 6.5, 14.3**
    - Use `fast-check` with `node:test` runner (same pattern as `RadioJobQueue.test.js`)
    - Create test file at `diivoo2mqtt/backend/core/ValveDeviceV4.test.js`

- [x] 3. Checkpoint - Ensure shared utility and state extensions work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add MQTT subscriptions and discovery messages
  - [x] 4.1 Add new MQTT topic subscriptions in `mqttBridge.js`
    - Add `const { normalizeSchedule, countTotalSchedules } = require('../core/channelConfig');` at top of mqttBridge.js
    - Extend `client.subscribe()` array in the `connect` handler with 5 new topic patterns: `diivoo/+/ch/+/default_duration/set`, `diivoo/+/ch/+/mist_on/set`, `diivoo/+/ch/+/mist_off/set`, `diivoo/+/ch/+/schedules/set`, `diivoo/+/valve/+/cmd`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 4.2 Add discovery messages for number entities (default_duration, mist_on, mist_off) in `publishAutoDiscovery()`
    - Add per-channel Number_Entity discovery for `default_duration` (min:1, max:65535, step:1, unit:'s', entity_category:'config')
    - Add per-channel Number_Entity discovery for `mist_on` (min:1, max:3600, step:1, unit:'s', entity_category:'config')
    - Add per-channel Number_Entity discovery for `mist_off` (min:1, max:3600, step:1, unit:'s', entity_category:'config')
    - Use retained publish, correct unique_ids, value_templates, command_topics, and icons as per design
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3_

  - [x] 4.3 Add discovery messages for diagnostic sensors (water_consumption, last_duration, last_event, firmware, hw_revision, rssi, target_runtime)
    - Add per-channel sensors: water_consumption (device_class:water, unit:mL, state_class:measurement), last_duration (device_class:duration, unit:s), last_event (device_class:timestamp), target_runtime (device_class:duration, unit:s)
    - Add device-level sensors: firmware (icon:mdi:chip), hw_revision (icon:mdi:information-outline), rssi (device_class:signal_strength, unit:dBm)
    - All with entity_category:'diagnostic', retained discovery, correct value_templates
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 13.1, 13.2, 13.3, 13.4, 14.1, 14.2, 14.3, 15.1, 15.2, 15.3, 15.4_

  - [x] 4.4 Add discovery for schedules JSON sensor
    - Add per-channel JSON_Sensor discovery with `json_attributes_topic` set to `diivoo/{valveId}/ch/{ch}/schedules/attributes`
    - State shows schedule count via value_template, icon `mdi:calendar-clock`
    - Retained publish
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [x] 4.5 Add discovery for valve entity (water)
    - Add per-channel valve entity with device_class:'water', reports_position:false
    - State maps `isRunning` → 'open'/'closed' via value_template
    - Command topic: `diivoo/{valveId}/valve/{ch}/cmd`, payload_open:'OPEN', payload_close:'CLOSE'
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.9_

- [x] 5. Implement command handlers and state publishing
  - [x] 5.1 Implement command handlers for number entities (default_duration, mist_on, mist_off) in `handleIncomingMessage()`
    - Add handler for `diivoo/{valveId}/ch/{channelId}/default_duration/set`: parse, validate (1–65535), mutate `channel.settings.durationSeconds`, call `_notifyStateChange()` then `sendPingTrigger(null, 2, 0x03)`
    - Add handler for `diivoo/{valveId}/ch/{channelId}/mist_on/set`: validate (1–3600), mutate `intervalOnSeconds`
    - Add handler for `diivoo/{valveId}/ch/{channelId}/mist_off/set`: validate (1–3600), mutate `intervalOffSeconds`
    - On invalid payload: log warning, re-publish current device state via `this.publishDeviceState()`
    - Initialize `channel.settings` if missing (default structure)
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 2.4, 2.5, 2.6, 2.7, 3.4, 3.5, 3.6, 3.7_

  - [x] 5.2 Implement schedules command handler in `handleIncomingMessage()`
    - Add handler for `diivoo/{valveId}/ch/{channelId}/schedules/set`
    - Parse JSON, validate is array, normalize each schedule via `normalizeSchedule()`
    - Check 6-schedule global limit via `countTotalSchedules()`
    - On valid: replace `channel.schedules`, call `_notifyStateChange()` then `sendPingTrigger()`
    - On invalid (bad JSON, not array, normalization error, limit exceeded): log warning, re-publish state AND schedules attributes
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [x] 5.3 Implement valve command handler in `handleIncomingMessage()`
    - Add handler for `diivoo/{valveId}/valve/{channelId}/cmd`
    - Handle `OPEN` (use defaultOpenSeconds), `CLOSE`, and JSON `{"command":"OPEN","duration":N}` (clamp 1–65535)
    - Silently discard unrecognized payloads
    - Ensure existing switch handler (`parts[4] === 'set'`) remains unchanged
    - _Requirements: 16.5, 16.6, 16.7, 16.8, 16.9, 16.10_

  - [x] 5.4 Implement `publishScheduleAttributes()` method and integrate into `publishDeviceState()`
    - Add `publishScheduleAttributes(device)` method: publish `{ schedules: [...] }` to `diivoo/{valveId}/ch/{ch}/schedules/attributes` with retain:true for each channel
    - Update `publishDeviceState()` to call `publishScheduleAttributes(device)` after the main state publish
    - _Requirements: 4.4, 4.5, 5.7_

- [x] 6. Checkpoint - Verify command handlers and discovery
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Add locale strings
  - [x] 7.1 Add locale strings for all new entity names to `en.json` and other locale files
    - Add keys: `valve_default_duration`, `valve_mist_on`, `valve_mist_off`, `valve_schedules`, `valve_water`, `valve_water_consumption`, `valve_last_duration`, `valve_last_event`, `valve_target_runtime`, `valve_firmware`, `valve_hw_revision`, `valve_rssi`
    - Use pattern with `{ch}` placeholder for per-channel entities (e.g., "Default Duration Ch{ch}")
    - Add to `en.json` first, then propagate to all other locale files
    - _Requirements: 1.1, 2.1, 3.1, 4.1, 9.1, 10.1, 11.1, 12.1, 13.1, 14.1, 15.1, 16.1_

- [x] 8. Write property-based tests
  - [x] 8.1 Write property test for valid command updates
    - **Property 1: Valid command updates are applied correctly**
    - **Validates: Requirements 1.4, 2.4, 3.4**
    - Generate random valid values per field, apply handler, assert channel.settings reflects exact value
    - Create test file at `diivoo2mqtt/backend/interfaces/mqttBridge.test.js`
    - Use `fast-check` with `node:test` runner, minimum 100 iterations

  - [x] 8.2 Write property test for invalid payload rejection
    - **Property 2: Invalid payloads are rejected without mutation and trigger state re-publish**
    - **Validates: Requirements 1.5, 2.5, 3.5**
    - Generate random invalid values (NaN, Infinity, 0, negative, out-of-range, non-numeric strings), assert no mutation + re-publish called

  - [x] 8.3 Write property test for schedule normalization consistency
    - **Property 3: Schedule normalization consistency**
    - **Validates: Requirements 5.3, 5.4**
    - Generate random schedule-like objects, normalize, assert canonical structure with valid fields
    - Create test file at `diivoo2mqtt/backend/core/channelConfig.test.js`

  - [x] 8.4 Write property test for global schedule limit enforcement
    - **Property 4: Global schedule limit enforcement**
    - **Validates: Requirements 5.5**
    - Generate random channel/schedule distributions where total > 6, assert rejection + re-publish

  - [x] 8.5 Write property test for invalid schedule payloads
    - **Property 5: Invalid schedule payloads are rejected and trigger re-publish**
    - **Validates: Requirements 5.6**
    - Generate random non-array payloads (numbers, strings, objects, null), assert rejection + re-publish

  - [x] 8.6 Write property test for schedule duration clamping
    - **Property 10: Schedule duration clamping invariant**
    - **Validates: Requirements 5.4**
    - Generate random integers, normalize schedule, assert durationMinutes in [1, 1092]

  - [x] 8.7 Write property test for valve entity defaultOpenSeconds usage
    - **Property 11: Valve entity uses defaultOpenSeconds when no duration specified**
    - **Validates: Requirements 16.6, 16.7**
    - Generate random defaultOpenSeconds values, send OPEN without duration, assert valve.on() called with that value

  - [x] 8.8 Write property test for invalid commands triggering state re-publish
    - **Property 12: Invalid commands trigger state re-publish**
    - **Validates: Requirements 1.5, 2.5, 3.5, 5.5, 5.6**
    - Generate random invalid payloads for each command type, assert re-publish with pre-mutation state

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The project uses `node:test` runner (no external test framework needed) — see `RadioJobQueue.test.js` for pattern
- `fast-check` (MIT license) is needed as a dev dependency for property-based tests
- The shared `channelConfig.js` module must be created before command handlers that depend on it
- Discovery messages and command handlers both depend on the subscription changes in 4.1

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4", "4.5"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3", "5.4"] },
    { "id": 5, "tasks": ["7.1"] },
    { "id": 6, "tasks": ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6", "8.7", "8.8"] }
  ]
}
```
