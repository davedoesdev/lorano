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
      promisify = require('util').promisify,
      delay = promisify(setTimeout),
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

function start_simulate(options, cb)
{
    uplink = new LeftDuplex();
    downlink = new LeftDuplex();

    const appid = Buffer.alloc(8),
          netid = crypto.randomBytes(3),
          deveui = Buffer.alloc(8),
          app_key = Buffer.alloc(16);

    link = new Link(TestModel, uplink.right, downlink.right, Object.assign(
    {
        appid: appid,
        netid: netid
    }, options));

    (async () => { try {
        const up = aw.createDuplexer(uplink),
              down = aw.createDuplexer(downlink),
              pull_data = Buffer.alloc(12);

        if (options.send_initial_unknown_packet)
        {
            await down.writeAsync(pull_data.slice(0, 1));
        }

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

        const payload_size = 12;
        let dev_addr, nwk_skey, app_skey;
        let fcnt_up = 0, fcnt_down = 0;
        if (options.otaa)
        {
            const dev_nonce = crypto.randomBytes(2);

            if (options.send_data_before_joined)
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
                                MType: 'Unconfirmed Data Up',
                                DevAddr: link.nwk_addr_to_dev_addr((await link._deveui_to_otaa_device(deveui)).NwkAddr),
                                payload: Buffer.alloc(payload_size),
                                FCnt: fcnt_up++
                            }, Buffer.alloc(16), Buffer.alloc(16)).getPHYPayload().toString('base64')
                        }]
                    }))
                ]));

                const push_ack = await up.readAsync();
                expect(push_ack.length).to.equal(4);
                expect(push_ack[0]).to.equal(PROTOCOL_VERSION);
                expect(push_ack[1]).to.equal(push_data[1]);
                expect(push_ack[2]).to.equal(push_data[2]);
                expect(push_ack[3]).to.equal(pkts.PUSH_ACK);
            }

            const request_join = async (appid, deveui, app_key) =>
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
                                DevNonce: dev_nonce
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
            };

            await request_join(appid, deveui, app_key);
            if (options.send_join_with_unknown_appid)
            {
                const appid2 = Buffer.from(appid);
                appid2[0] ^= 0xff;
                await request_join(appid2, deveui, app_key);
            }
            if (options.send_join_with_unknown_deveui)
            {
                const deveui2 = Buffer.from(deveui);
                deveui2[0] ^= 0xff;
                await request_join(appid, deveui2, app_key);
            }
            if (options.send_join_with_wrong_appkey)
            {
                const app_key2 = Buffer.from(app_key);
                app_key2[0] ^= 0xff;
                await request_join(appid, deveui, app_key2);
            }
            if (options.replay_join)
            {
                await request_join(appid, deveui, app_key);
            }

            const pull_resp = await down.readAsync();
            if (!pull_resp) { return; }
            expect(pull_resp.length).to.be.at.least(4);
            expect(pull_resp[0]).to.equal(PROTOCOL_VERSION);
            expect(pull_resp[3]).to.equal(pkts.PULL_RESP);

            let decoded = lora_packet.fromWire(Buffer.from(
                    JSON.parse(pull_resp.slice(4)).txpk.data, 'base64'));
            expect(decoded.getMType()).to.equal('Join Accept');

            const tx_ack = Buffer.alloc(12);
            tx_ack[0] = PROTOCOL_VERSION;
            tx_ack[1] = pull_resp[1];
            tx_ack[2] = pull_resp[2];
            tx_ack[3] = pkts.TX_ACK;
            await down.writeAsync(tx_ack);

            const cipher = crypto.createCipheriv('aes-128-ecb', app_key, '');
            cipher.setAutoPadding(false);

            let buffers = decoded.getBuffers();
            decoded = lora_packet.fromWire(Buffer.concat(
            [
                buffers.MHDR,
                cipher.update(buffers.MACPayloadWithMIC),
                cipher.final()
            ]));
            expect(decoded.getMType()).to.equal('Join Accept');
            expect(lora_packet.verifyMIC(decoded, null, app_key)).to.be.true;

            buffers = decoded.getBuffers();
            expect(buffers.NetID.equals(netid)).to.be.true;
            expect(buffers.DevAddr[0] >> 1).to.equal(netid[2] & 0x7f);
            dev_addr = buffers.DevAddr;
            expect((await link.dev_addr_to_deveui(dev_addr)).equals(deveui)).to.be.true;
            const dev_addr2 = Buffer.from(dev_addr);
            dev_addr2[0] ^= 0xff;
            expect(await link.dev_addr_to_deveui(dev_addr2)).to.equal(null);
            
            nwk_skey = Link.skey(netid, app_key, 0x01, buffers.AppNonce, dev_nonce);
            app_skey = Link.skey(netid, app_key, 0x02, buffers.AppNonce, dev_nonce);
        }
        else
        {
            dev_addr = Buffer.alloc(4);
            nwk_skey = Buffer.alloc(16);
            app_skey = Buffer.alloc(16);
        }

        let recv_payload = Buffer.alloc(payload_size);

        while (true)
        {
            const send_payload = Buffer.concat(
            [
                crypto.randomBytes(payload_size / 2),
                recv_payload.slice(payload_size / 2)
            ]);

            const send_data = async (dev_addr, nwk_skey, fcnt_up) =>
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
                                MType: 'Unconfirmed Data Up',
                                DevAddr: dev_addr,
                                payload: send_payload,
                                FCnt: fcnt_up
                            }, app_skey, nwk_skey).getPHYPayload().toString('base64')
                        }]
                    }))
                ]));

                const push_ack = await up.readAsync();
                expect(push_ack.length).to.equal(4);
                expect(push_ack[0]).to.equal(PROTOCOL_VERSION);
                expect(push_ack[1]).to.equal(push_data[1]);
                expect(push_ack[2]).to.equal(push_data[2]);
                expect(push_ack[3]).to.equal(pkts.PUSH_ACK);
            };

            await send_data(dev_addr, nwk_skey, fcnt_up++);
            if (options.send_data_with_unknown_devaddr)
            {
                const dev_addr2 = Buffer.from(dev_addr);
                dev_addr2[0] ^= 0xff;
                await send_data(dev_addr2, nwk_skey, fcnt_up++);
            }
            if (options.send_data_with_wrong_session_key)
            {
                const nwk_skey2 = Buffer.from(nwk_skey);
                nwk_skey2[0] ^= 0xff;
                await send_data(dev_addr, nwk_skey2, fcnt_up++);
            }
            if (options.replay_data)
            {
                await send_data(dev_addr, nwk_skey, fcnt_up - 1);
            }
            if (options.send_no_rxpk)
            {
                const push_data = Buffer.alloc(12);
                push_data[0] = PROTOCOL_VERSION;
                crypto.randomFillSync(push_data, 1, 2);
                push_data[3] = pkts.PUSH_DATA;
                await up.writeAsync(Buffer.concat(
                [
                    push_data,
                    Buffer.from(JSON.stringify({}))
                ]));

                const push_ack = await up.readAsync();
                expect(push_ack.length).to.equal(4);
                expect(push_ack[0]).to.equal(PROTOCOL_VERSION);
                expect(push_ack[1]).to.equal(push_data[1]);
                expect(push_ack[2]).to.equal(push_data[2]);
                expect(push_ack[3]).to.equal(pkts.PUSH_ACK);
            }

            const pull_resp = await down.readAsync();
            if (!pull_resp) { break; }
            expect(pull_resp.length).to.be.at.least(4);
            expect(pull_resp[0]).to.equal(PROTOCOL_VERSION);
            expect(pull_resp[3]).to.equal(pkts.PULL_RESP);

            let decoded = lora_packet.fromWire(Buffer.from(
                    JSON.parse(pull_resp.slice(4)).txpk.data, 'base64'));
            expect(decoded.getMType()).to.equal('Unconfirmed Data Down');

            const tx_ack = Buffer.alloc(12);
            tx_ack[0] = PROTOCOL_VERSION;
            tx_ack[1] = pull_resp[1];
            if (options.write_wrong_tx_ack_token)
            {
                tx_ack[1] ^= 0xff;
            }
            tx_ack[2] = pull_resp[2];
            tx_ack[3] = pkts.TX_ACK;
            await down.writeAsync(tx_ack);

            const buffers = decoded.getBuffers();
            expect(buffers.DevAddr.equals(dev_addr)).to.equal(true);
            expect(lora_packet.verifyMIC(decoded, nwk_skey)).to.be.true;
            const fcnt = Buffer.alloc(2);
            fcnt.writeUInt16BE(fcnt_down++, 0);
            expect(buffers.FCnt.equals(fcnt)).to.be.true;

            recv_payload = lora_packet.decrypt(decoded, app_skey, nwk_skey);
            expect(recv_payload.length).to.equal(payload_size);
            expect(recv_payload.compare(send_payload,
                                        0,
                                        payload_size/2,
                                        0,
                                        payload_size/2)).to.equal(0);
        }
    } catch (ex) {
        console.error(ex);
    }})();

    link.on('ready', options.throw_error_in_ready ? function ()
    {
        throw new Error('dummy');
    } : cb);

    link.on('error', options.error_handler || cb);
}

function stop_simulate(cb)
{
    uplink.end();
    downlink.end();
    downlink.right.end();
    return cb();
}

function start(cb)
{
    if (!deveui)
    {
        return start_simulate({ otaa: true }, cb);
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

async function same_data_sent_with_options(options)
{
    options = options || {};

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

        if (options.write_to_unknown_device)
        {
            recv_data.reply.encoding.DevAddr[0] ^= 0xff;
        }

        await duplex.writeAsync(recv_data.reply);

        if (options.delay_after_write !== undefined)
        {
            await delay(options.delay_after_write);
        }
    }
}

async function same_data_sent()
{
    await same_data_sent_with_options();
}

describe('should emit error when writing to unjoined device', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        error_handler: function (err)
        {
            expect(err.message).to.equal('device not joined');
        }
    }, cb));
    afterEach(stop_simulate);

    it('should error sending data', async () =>
    {
        let err;
        try
        {
            const deveui = Buffer.alloc(8),
                  dev_addr = link.nwk_addr_to_dev_addr((await link._deveui_to_otaa_device(deveui)).NwkAddr),
                  write = promisify((data, cb) => link.write(data, cb));
            await write(
            {
                encoding: {
                    DevAddr: dev_addr
                }
            });
        }
        catch (ex)
        {
            err = ex;
        }
        expect(err.message).to.equal('device not joined');
    });
});

describe('should emit not_joined event when packet received from unjoined OTAA device', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        send_data_before_joined : true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
    {
        let called = false;
        link.on('not_joined', () =>
        {
            called = true;
        });
        await same_data_sent();
        expect(called).to.be.true;
    });
});

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
    beforeEach(cb => start_simulate({ otaa: false }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', same_data_sent);
});

describe('should cope with unknown packets', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        send_initial_unknown_packet: true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', same_data_sent);
});

describe('should emit error occurring while waiting for initial packet', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        throw_error_in_ready: true,
        error_handler: function (err)
        {
            expect(err.message).to.equal('dummy');
            cb();
        }
    }, cb));
    afterEach(stop_simulate);

    it('should emit error', same_data_sent);
});

describe('should pass options to Duplex', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        highWaterMark: 0
    }, cb));
    beforeEach(() =>
    {
        expect(link.readableHighWaterMark).to.equal(0);
        expect(link.writableHighWaterMark).to.equal(0);
    });
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
        await same_data_sent_with_options(
        {
            delay_after_write: 500
        }));
});

describe('should ignore packet with missing rxpk', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        send_no_rxpk: true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', same_data_sent);
});

describe('should emit errors that occur while reading', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        error_handler: function (err)
        {
            expect(err.message).to.equal('dummy');
        }
    }, cb));
    beforeEach(() =>
    {
        link._pending.shift = function ()
        {
            throw new Error('dummy');
        };
    });
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
    {
        let err;
        try
        {
            await same_data_sent();
        }
        catch (ex)
        {
            err = ex;
        }
        expect(err.message).to.equal('dummy');
    });
});

describe('should emit error when writing to unknown device', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        error_handler: function (err)
        {
            expect(err.message).to.equal('unknown device');
        }
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
    {
        let err;
        try
        {
            await same_data_sent_with_options(
            {
                write_to_unknown_device: true
            });
        }
        catch (ex)
        {
            err = ex;
        }
        expect(err.message).to.equal('unknown device');
    });
});

describe('should emit error when FCntDownMax exceeded', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        FCntDownMax: -1,
        error_handler: function (err)
        {
            expect(err.message).to.equal('send frame count exceeded');
        }
    }, cb));
    afterEach(stop_simulate);

    it('should error sending data', async () =>
    {
        let err;
        try
        {
            const deveui = Buffer.alloc(8),
                  dev_addr = link.nwk_addr_to_dev_addr((await link._deveui_to_otaa_device(deveui)).NwkAddr),
                  write = promisify((data, cb) => link.write(data, cb));
            await write({ encoding: { DevAddr: dev_addr } });
        }
        catch (ex)
        {
            err = ex;
        }
        expect(err.message).to.equal('send frame count exceeded');
    });
});

describe('should emit error when TX_ACK token does not match', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        write_wrong_tx_ack_token: true,
        error_handler: function (err)
        {
            expect(err.message).to.equal('TX_ACK token mismatch');
        }
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
    {
        let err;
        try
        {
            await same_data_sent();
        }
        catch (ex)
        {
            err = ex;
        }
        expect(err.message).to.equal('TX_ACK token mismatch');
    });
});

describe('should ignore join requests with unknown appid', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        send_join_with_unknown_appid: true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', same_data_sent);
});

describe('should ignore join requests with unknown deveui', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        send_join_with_unknown_deveui: true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', same_data_sent);
});

describe('should ignore join requests with wrong app key and emit verify_mic event', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        send_join_with_wrong_appkey : true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
    {
        let called = false;
        link.on('verify_mic_failed', (device, decoded) =>
        {
            expect(device.DevEUI.equals(Buffer.alloc(8))).to.be.true;
            expect(decoded.getBuffers().DevEUI.equals(Buffer.alloc(8))).to.be.true;
            called = true;
        });
        await same_data_sent();
        expect(called).to.be.true;
    });
});

describe('should ignore replayed join requests and emit join_replay event', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        replay_join : true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
    {
        let called = false;
        link.on('join_replay', (device, decoded, ex) =>
        {
            expect(device.DevEUI.equals(Buffer.alloc(8))).to.be.true;
            expect(decoded.getBuffers().DevEUI.equals(Buffer.alloc(8))).to.be.true;
            called = true;
        });
        await same_data_sent();
        expect(called).to.be.true;
    });
});

describe('should ignore data packets with unknown devaddr', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        send_data_with_unknown_devaddr: true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', same_data_sent);
});

describe('should ignore data packets with wrong session key and emit verify_mic event', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        send_data_with_wrong_session_key : true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
    {
        let called = false;
        link.on('verify_mic_failed', (device, decoded) =>
        {
            expect(device.DevEUI.equals(Buffer.alloc(8))).to.be.true;
            called = true;
        });
        await same_data_sent();
        expect(called).to.be.true;
    });
});

describe('should ignore replayed data packets and emit data_replay event', function ()
{
    beforeEach(cb => start_simulate(
    {
        otaa: true,
        replay_data : true
    }, cb));
    afterEach(stop_simulate);

    it('should receive same data sent', async () =>
    {
        let called = false;
        link.on('data_replay', (device, decoded) =>
        {
            expect(device.DevEUI.equals(Buffer.alloc(8))).to.be.true;
            called = true;
        });
        await same_data_sent();
        expect(called).to.be.true;
    });
});
