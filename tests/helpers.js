// Test harness: in-memory chrome.storage.local, a fake clock, and an engine wired to the mock API.
const Api = require('../instagram-api.js');
const Mock = require('../mock-api.js');
const Engine = require('../scan-engine.js');

function makeStorage() {
  const data = {};
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    data,
    async get(keys) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
        if (k in data) out[k] = clone(data[k]);
      });
      return out;
    },
    async set(obj) {
      Object.keys(obj).forEach((k) => {
        if (obj[k] === null) delete data[k];
        else data[k] = clone(obj[k]);
      });
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete data[k]);
    },
  };
}

function makeClock() {
  const clock = { t: 1_700_000_000_000 };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.t += ms;
  };
  return clock;
}

/** One "browser tab": engine + mock + shared storage/clock. Create a new one to simulate a reload. */
function makeTab({ storage, clock, scenario = 'normal', mockOpts = {}, onSleep, config = {}, instanceId } = {}) {
  const mock = Mock.createMock(Object.assign({ scenario, now: clock.now }, mockOpts));
  let engine;
  const api = Api.createApi({
    fetchImpl: mock.fetchImpl,
    cookieString: mock.cookieString,
    now: clock.now,
    onRequest: (i) => engine.noteRequest(i),
  });
  const events = [];
  let sleeps = 0;
  engine = Engine.createEngine({
    storage,
    api,
    now: clock.now,
    sleep: async (ms) => {
      sleeps += 1;
      if (onSleep) onSleep(sleeps, engine);
      clock.t += ms;
    },
    random: (() => {
      let s = 12345;
      return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    })(),
    hooks: { onEvent: (e) => events.push(e), keepAwake: () => {} },
    config,
    instanceId,
  });
  return { engine, mock, events, sleeps: () => sleeps };
}

module.exports = { makeStorage, makeClock, makeTab };
