'use strict';
var fs = require('fs');
var heimdall = require('heimdalljs');
var logger = require('heimdalljs-logger')('heimdalljs-fs-monitor');

// It is possible for this module to be evaluated more than once in the same
// heimdall session. In that case, we need to guard against double-counting by
// making other instances of FSMonitor inert.
var isMonitorRegistrant = false;
var hasActiveInstance = false;

class FSMonitor {
  constructor() {
    this.state = 'idle';
    this.blacklist = ['createReadStream', 'createWriteStream', 'ReadStream', 'WriteStream'];
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

  _measure(name, original, context, args) {
    if (this.state !== 'active') {
      throw new Error('Cannot measure if the monitor is not active');
    }

    var metrics = heimdall.statsFor('fs');
    var m = metrics[name] = metrics[name] || new Metric();

    m.start();

    // TODO: handle async
    try {
      return original.apply(context, args);
    } finally {
      m.stop();
    }
  }

  _attach() {
    var monitor = this;

    for (var member in fs) {
      if (this.blacklist.indexOf(member) === -1) {
        var old = fs[member];
        if (typeof old === 'function') {
          fs[member] = (function(old, member) {
            return function() {
              if (monitor.shouldMeasure()) {
                var args = new Array(arguments.length);
                for (var i = 0; i < arguments.length; i++) {
                  args[i] = arguments[i];
                }

                return monitor._measure(member, old, fs, args);
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
    for (var member in fs) {
      var maybeFunction = fs[member];
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
    this.startTime = undefined;
  }

  start() {
    this.startTime = process.hrtime();
    this.count++;
  }

  stop() {
    var now = process.hrtime();

    this.time += (now[0] - this.startTime[0]) * 1e9 + (now[1] - this.startTime[1]);
    this.startTime = undefined;
  }

  toJSON() {
    return {
      count: this.count,
      time: this.time
    };
  }
}

