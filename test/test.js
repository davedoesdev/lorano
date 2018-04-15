"use strict";

// Tested with a SODAQ ExpLoRer running ./lorano_test.ino

const Link = require('..'),
      lora_comms = require('lora-comms'),
      aw = require('awaitify-stream'),
      lora_packet = require('lora-packet'),
      { Model } = require('objection'),
      Knex = require('knex'),
      expect = require('chai').expect,
      path = require('path'),
      crypto = require('crypto'),
      { LeftDuplex } = require('./memory-duplex'),
      deveui = require('yargs').argv.deveui,
      PROTOCOL_VERSION = 2,
      pkts = {
          PUSH_DATA: 0,
          PUSH_ACK: 1,
          PULL_DATA: 2,
          PULL_RESP: 3,
          PULL_ACK: 4,
          TX_ACK: 5
      };

let link, TestModel, uplink, downlink;

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

function start_simulate(otaa, cb)
{
    uplink = new LeftDuplex();
    downlink = new LeftDuplex();

    const appid = Buffer.alloc(8),
          netid = crypto.randomBytes(3),
          deveui = Buffer.alloc(8),
          app_key = Buffer.alloc(16);

    link = new Link(TestModel, uplink.right, downlink.right,
    {
        appid: appid,
        netid: netid
    });

    (async () => { try {
        const up = aw.createDuplexer(uplink),
              down = aw.createDuplexer(downlink),
              pull_data = Buffer.alloc(12);

        pull_data[0] = PROTOCOL_VERSION;
        crypto.randomFillSync(pull_data, 1, 2);
        pull_data[3] = pkts.PULL_DATA;
        await down.writeAsync(pull_data);

        const pull_ack = await down.readAsync();
        expect(pull_ack.length).to.equal(4);
        expect(pull_ack[0]).to.equal(PROTOCOL_VERSION);
        expect(pull_ack[1]).to.equal(pull_data[1]);
        expect(pull_ack[2]).to.equal(pull_data[2]);
        expect(pull_ack[3]).to.equal(pkts.PULL_ACK);
            
        if (otaa)
        {
            const push_data = Buffer.alloc(12);
            push_data[0] = PROTOCOL_VERSION;
            crypto.randomFillSync(push_data, 1, 2);
            push_data[3] = pkts.PUSH_DATA;
            await up.writeAsync(Buffer.concat(
            [
                push_data,
                Buffer.from(JSON.stringify(
                {
                    rxpk: [{
                        data: lora_packet.fromFields({
                            MType: 'Join Request',
                            AppEUI: appid,
                            DevEUI: deveui,
                            DevNonce: crypto.randomBytes(2)
                        }, null, null, app_key).getPHYPayload().toString('base64')
                    }]
                }))
            ]));

            const push_ack = await up.readAsync();
            expect(push_ack.length).to.equal(4);
            expect(push_ack[0]).to.equal(PROTOCOL_VERSION);
            expect(push_ack[1]).to.equal(push_data[1]);
            expect(push_ack[2]).to.equal(push_data[2]);
            expect(push_ack[3]).to.equal(pkts.PUSH_ACK);
     
            const pull_resp = await down.readAsync();
            expect(pull_resp.length).to.be.at.least(4);
            expect(pull_resp[0]).to.equal(PROTOCOL_VERSION);
            expect(pull_resp[3]).to.equal(pkts.PULL_RESP);

            console.log(JSON.parse(pull_resp.slice(4)));

 
        
            // TODO: check join accept
            // calculate session key
        }

        // TODO: simulate and check data
    } catch (ex) {
        console.error(ex);
    }})();

    link.on('ready', cb);
    link.on('error', cb);
}

function stop_simulate(cb)
{
    uplink.end();
    downlink.end();
    return cb();
}

function start(cb)
{
    if (!deveui)
    {
        return start_simulate(true, cb);
    }

    lora_comms.start_logging();
    lora_comms.log_info.pipe(process.stdout);
    lora_comms.log_error.pipe(process.stderr);
    lora_comms.start();
    link = new Link(TestModel, lora_comms.uplink, lora_comms.downlink,
    {
        // USE YOUR OWN IDS!
        appid: Buffer.alloc(8),
        netid: crypto.randomBytes(3) // 7 lsb = NwkId
    });
    link.on('ready', cb);
    link.on('error', cb);
}

function stop(cb)
{
    if (!deveui)
    {
        return stop_simulate(cb);
    }

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
    if (!deveui || !lora_comms.logging_active)
    {
        return cb();
    }

    lora_comms.once('logging_stop', cb);
    // no need to call lora_comms.stop_logging(), logging_stop will be emitted
    // once the log streams end
}

async function same_data_sent()
{
    const payload_size = 12;
    let duplex = aw.createDuplexer(link);
    let send_payload = crypto.randomBytes(payload_size);

    while (true)
    {
        let recv_data = await duplex.readAsync();
        if (recv_data.payload.length !== payload_size)
        {
            continue;
        }

        if (recv_data.payload.equals(send_payload))
        {
            // Shouldn't happen because send on reverse polarity
            console.error('Received packet we sent');
            continue;
        }

        if (recv_data.payload.compare(send_payload,
                                      payload_size/2,
                                      payload_size,
                                      payload_size/2,
                                      payload_size) === 0)
        {
            return;
        }

        send_payload = Buffer.concat([recv_data.payload.slice(0, payload_size/2),
                                      crypto.randomBytes(payload_size/2)]);
        recv_data.reply.payload = send_payload;
        await duplex.writeAsync(recv_data.reply);
    }
}

describe('echoing device with OTAA', function ()
{
    this.timeout(60 * 60 * 1000);

    beforeEach(start);
    afterEach(stop);
    afterEach(wait_for_logs);

    it('should receive same data sent', same_data_sent);
});

describe('echoing device with ABP', function ()
{
    beforeEach(cb => start_simulate(false, cb));
    afterEach(stop_simulate);

    // TODO: it('should receive same data sent', same_data_sent);
});

// TODO: Fill in coverage by simulating requests
