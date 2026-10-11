const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('failed dashboard refresh preserves recent device status, clears targets, and expires', () => {
  const context = vm.createContext({ document: { addEventListener() {} }, Date });
  const source = fs.readFileSync(path.join(__dirname, '../light-ui.js'), 'utf8');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.dashboardTest={state,handlePollFailure};})();'), context);
  const { state, handlePollFailure } = context.dashboardTest;
  state.telemetry = { connected:true, lastData:new Date().toISOString(), targets:[{targetId:'S1-T1'}], system:{esp:true,alarmActive:true}, gsm:{connected:true}, sensors:[{id:1,online:true,targetCount:1}] };
  state.trails.set('S1-T1', [{}]);
  handlePollFailure();
  assert.equal(state.apiConnected, false);
  assert.equal(state.telemetry.connected, true);
  assert.equal(state.telemetry.gsm.connected, true);
  assert.equal(state.telemetry.sensors[0].online, true);
  assert.equal(state.telemetry.targets.length, 0);
  assert.equal(state.telemetry.sensors[0].targetCount, 0);
  assert.equal(state.telemetry.system.alarmActive, false);
  assert.equal(state.trails.size, 0);
  state.telemetry.lastData = new Date(Date.now() - 15001).toISOString();
  handlePollFailure();
  assert.equal(state.telemetry.connected, false);
  assert.equal(state.telemetry.sensors[0].online, false);
});
