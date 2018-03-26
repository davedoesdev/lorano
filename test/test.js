"use strict";

// Tested with a SODAQ ExpLoRer running ./lorano_test.ino

const { LoRaNo } = require('..'),
      lora_comms = require('lora-comms'),
      aw = require('awaitify-stream'),
      { Model } = require('objection'),
      Knex = require('knex'),
      expect = require('chai').expect,
      path = require('path');

let link, TestModel;

before(function ()
{
    const knex = Knex({
        client: 'sqlite3',
        useNullAsDefault: true,
        connection: {
            filename: path.join(__dirname, 'lorano.sqlite3')
        }
    });

    TestModel = class extends Model {};
    TestModel.knex(knex);
});

function start()
{
    lora_comms.start_logging();
    lora_comms.log_info.pipe(process.stdout);
    lora_comms.log_error.pipe(process.stderr);
    lora_comms.start();
    link = new LoRaNo(TestModel, lora_comms.uplink, lora_comms.downlink).link;
}

function stop(cb)
{
    if (!lora_comms.active)
    {
        return cb();
    }

    lora_comms.once('stop', cb);
    lora_comms.stop();
}
process.on('SIGINT', () => stop(() => {}));

function wait_for_logs(cb)
{
    if (!lora_comms.logging_active)
    {
        return cb();
    }

    lora_comms.once('logging_stop', cb);
    // no need to call lora_comms.stop_logging(), logging_stop will be emitted
    // once the log streams end
}

beforeEach(start);
afterEach(stop);
afterEach(wait_for_logs);

describe('echoing device with OTAA', function ()
{
    this.timeout(60 * 60 * 1000);

    it('should receive same data sent', async function ()
    {

    });
});
