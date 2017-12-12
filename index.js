'use strict';
const fs = require('fs');
const heimdall = require('heimdalljs');
const logger = require('heimdalljs-logger')('heimdalljs-fs-monitor');
module.exports = FSMonitor;

// It is possible for this module to be evaluated more than once in the same
// heimdall session. In that case, we need to guard against double-counting by
// making other instances of FSMonitor inert.
let isMonitorRegistrant = false;
let hasActiveInstance = false;

function FSMonitor() {
  this.state = 'idle';
  this.blacklist = ['createReadStream', 'createWriteStream', 'ReadStream', 'WriteStream'];
}

FSMonitor.prototype.start = function() {
  if (isMonitorRegistrant && !hasActiveInstance) {
    this.state = 'active';
    this._attach();
    hasActiveInstance = true;
  } else {
    logger.warn('Multiple instances of heimdalljs-fs-monitor have been created'
      + ' in the same session. Since this can cause fs operations to be counted'
      + ' multiple times, this instance has been disabled.');
  }
};

FSMonitor.prototype.stop = function() {
  if (this.state === 'active') {
    this.state = 'idle';
    this._detach();
    hasActiveInstance = false;
  }
};

FSMonitor.prototype.shouldMeasure = function() {
  return this.state === 'active';
};

if (!heimdall.hasMonitor('fs')) {
  heimdall.registerMonitor('fs', function FSSchema() {});
  isMonitorRegistrant = true;
}

function Metric() {
  this.count = 0;
  this.time = 0;
  this.startTime = undefined;
}

Metric.prototype.start = function() {
  this.startTime = process.hrtime();
  this.count++;
};

Metric.prototype.stop = function() {
  let now = process.hrtime();

  this.time += (now[0] - this.startTime[0]) * 1e9 + (now[1] - this.startTime[1]);
  this.startTime = undefined;
};

Metric.prototype.toJSON = function() {
  return {
    count: this.count,
    time: this.time
  };
};

FSMonitor.prototype._measure = function(name, original, context, args) {
  if (this.state !== 'active') {
    throw new Error('Cannot measure if the monitor is not active');
  }

  let metrics = heimdall.statsFor('fs');
  let m = metrics[name] = metrics[name] || new Metric();

  m.start();

  // TODO: handle async
  try {
    return original.apply(context, args);
  } finally {
    m.stop();
  }
};

FSMonitor.prototype._monitorMember = function _monitorMember(member) {
  let old = fs[member];
  if (typeof old === 'function') {
    fs[member] = (function(old, member) {
      return function() {
        if (this.shouldMeasure()) {
          let args = new Array(arguments.length);
          for (let i = 0; i < arguments.length; i++) {
            args[i] = arguments[i];
          }

          return this._measure(member, old, fs, args);
        } else {
          return old.apply(fs, arguments);
        }
      };
    }(old, member));

    fs[member].__restore = function() {
      fs[member] = old;
    };
  }
};

FSMonitor.prototype._attach = function() {
  for (let member in fs) {
    if (this.blacklist.indexOf(member) === -1) {
      this._monitorMember(member);
    }
  }
};

FSMonitor.prototype._detach = function() {
  for (let member in fs) {
    let maybeFunction = fs[member];
    if (typeof maybeFunction === 'function' && typeof maybeFunction.__restore === 'function') {
      maybeFunction.__restore();
    }
  }
};
