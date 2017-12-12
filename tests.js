var FSMonitor = require('./');
var expect = require('chai').expect;

describe('FSMonitor', function() {
  it('will only allow one active instance at a time', function() {
    var monitor0 = new FSMonitor();
    var monitor1 = new FSMonitor();

    monitor0.start();
    monitor1.start();

    expect(monitor0.state, 'monitor0 (m0 active)').to.eql('active');
    expect(monitor1.state, 'monitor1 (m0 active)').to.eql('idle');

    monitor0.stop();

    monitor1.start();
    monitor0.start();

    expect(monitor0.state, 'monitor0 (m1 active)').to.eql('idle');
    expect(monitor1.state, 'monitor1 (m1 active)').to.eql('active');
  });
});
