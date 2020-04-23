'use strict';

const fs = require('fs');
const heimdall = require('heimdalljs');
const logger = require('heimdalljs-logger')('heimdalljs-fs-monitor');

// It is possible for this module to be evaluated more than once in the same
// heimdall session. In that case, we need to guard against double-counting by
// making other instances of FSMonitor inert.
let isMonitorRegistrant = false;
let hasActiveInstance = false;

class FSMonitor {
  constructor() {
    this.state = 'idle';
    this.blacklist = [
      'createReadStream',
      'createWriteStream',
      'Dirent',
      'FSWatcher',
      'ReadStream',
      'Stats',
      'WriteStream'
    ];
  }

  start() {
    if (isMonitorRegistrant && !hasActiveInstance) {
      this.state = 'active';
      this._attach();
      hasActiveInstance = true;
    } else {
      logger.warn('Multiple instances of heimdalljs-fs-monitor have been created'
        + ' in the same session. Since this can cause fs operations to be counted'
        + ' multiple times, this instance has been disabled.');
    }
  }

  stop() {
    if (this.state === 'active') {
      this.state = 'idle';
      this._detach();
      hasActiveInstance = false;
    }
  }

  shouldMeasure() {
    return this.state === 'active';
  }

  _measure(name, original, context, args, location) {
    if (this.state !== 'active') {
      throw new Error('Cannot measure if the monitor is not active');
    }

    let metrics = heimdall.statsFor('fs');
    let m = metrics[name] = metrics[name] || new Metric();

    m.start(location);

    // TODO: handle async
    try {
      return original.apply(context, args);
    } finally {
      m.stop();
    }
  }

  _attach() {
    let monitor = this;

    for (let member in fs) {
      if (this.blacklist.indexOf(member) === -1) {
        let old = fs[member];
        if (typeof old === 'function') {
          fs[member] = (function(old, member) {
            return function() {
              if (monitor.shouldMeasure()) {
                let args = new Array(arguments.length);
                for (let i = 0; i < arguments.length; i++) {
                  args[i] = arguments[i];
                }

                let location;

                try {
                  /*
                    Uses error to build a stack of where the fs call was coming from.

                    An example output of what this will look like is

                    {
                      fileName: '/users/home/heimdall-fs-monitor/tests.js',
                      lineNumber: '87',
                      statckTrace: [
                        '    at Object.readFileSync (/users/home/heimdall-fs-monitor/index.js:87:29)',
                        '    at Context.<anonymous> (/users/home/heimdall-fs-monitor/tests.js:87:8)',
                        '    at callFn (/users/home/heimdall-fs-monitor/node_modules/mocha/lib/runnable.js:383:21)',
                        '    at Test.Runnable.run (/users/home/heimdall-fs-monitor/node_modules/mocha/lib/runnable.js:375:7)',
                        '    at Runner.runTest (/users/home/heimdall-fs-monitor/node_modules/mocha/lib/runner.js:446:10)',
                        '    at /users/home/heimdall-fs-monitor/node_modules/mocha/lib/runner.js:564:12',
                        '    at next (/users/home/heimdall-fs-monitor/node_modules/mocha/lib/runner.js:360:14)',
                        '    at /users/home/heimdall-fs-monitor/node_modules/mocha/lib/runner.js:370:7',
                        '    at next (/users/home/heimdall-fs-monitor/node_modules/mocha/lib/runner.js:294:14)',
                        '    at Immediate._onImmediate (/users/home/heimdall-fs-monitor/node_modules/mocha/lib/runner.js:338:5)',
                        '    at processImmediate (internal/timers.js:456:21)'
                      ]
                    }
                   */
                  const e = new Error();
                  // removing error from the first line of the trace
                  const statckTrace = e.stack.split("\n").slice(1, e.stack.split("\n").length);
                  const frame = e.stack.split("\n")[2];
                  const arr = frame.split(" ");
                  const functionName = arr[5];
                  const where = arr[6].split(/[:()]/);
                  const fileName = where[1];
                  const lineNumber = where[2];

                  location = {
                    fileName,
                    lineNumber,
                    statckTrace,
                  }
                } catch(ex) {}

                return monitor._measure(member, old, fs, args, location);
              } else {
                return old.apply(fs, arguments);
              }
            };
          }(old, member));

          fs[member].__restore = function() {
            fs[member] = old;
          };
        }
      }
    }
  }

  _detach() {
    for (let member in fs) {
      let maybeFunction = fs[member];
      if (typeof maybeFunction === 'function' && typeof maybeFunction.__restore === 'function') {
        maybeFunction.__restore();
      }
    }
  }
}

module.exports = FSMonitor;

if (!heimdall.hasMonitor('fs')) {
  heimdall.registerMonitor('fs', function FSSchema() {});
  isMonitorRegistrant = true;
}

class Metric {
  constructor() {
    this.count = 0;
    this.time = 0;
    this.invocations = [];
    this.startTime = undefined;
  }

  start(location) {
    // we want to push all the locations of our invocations to an array
    this.invocations.push(location)
    this.startTime = process.hrtime();
    this.count++;
  }

  stop() {
    let now = process.hrtime();

    this.time += (now[0] - this.startTime[0]) * 1e9 + (now[1] - this.startTime[1]);
    this.startTime = undefined;
  }

  toJSON() {
    return {
      invocations: this.invocations,
      count: this.count,
      time: this.time
    };
  }
}
