/*
ABP
Need to store DevAddr, NwkSKey, AppSKey

OTAA
Generate AppNonce
NetID: NwkID (7 LSB), rest chosen by network operator
   Private: 000000 or 000001
DevAddr 7 MSB (NwkId) then unique/random
   Can use subnet by fixing some of NetID after NwkID and here
DLSettings
   7 RFU (reserved)
   6-4 RX1DRoffset. Just subtracts (see below for data rates)
       See section 7.1.7.
   3-0 RX2 data rate (same as LinkADRReq)
     Region-specific. EU:
     0 SF12 / 125kHz
     1 SF11 / 125kHz
     2 SF10 / 125kHz
     3 SF9 / 125kHz
     4 SF8 / 125kHz
     5 SF7 / 125kHz
     6 SF7 / 250kHz
     7 FSK: 50kbps
     8-15 RFU
RxDelay
   7-4 RFU
   3-0 Delay in seconds
CFList (optional)
   Frequences of channels 4-8
   Each 3 bytes (24 bit, freq in Hz / 100), unused is 0
   Followed by 1 RFU byte


How to present this?

Pass in uplink and downlink and get back a Duplex for receiving and sending
data? We'd get objects with the payload and metadata? It would automatically
send back ACKs etc. It would automatically cope with OTAA and in future
end-to-end encryption (DH).
*/
"use strict";

process.env.UV_THREADPOOL_SIZE = (process.env.UV_THREADPOOL_SIZE || 4) + 3;

const { Duplex, Transform } = require('stream'),
      crypto = require('crypto'),
      aw = require('awaitify-stream'),
      lora_packet = require('lora-packet'),
      PROTOCOL_VERSION = 2,
      pkts = {
          PUSH_DATA: 0,
          PUSH_ACK: 1,
          PULL_DATA: 2,
          PULL_RESP: 3,
          PULL_ACK: 4,
          TX_ACK: 5
      };

async function wait_for(link, pkt)
{
    while (true)
    {
        let data = await link.readAsync();
        if (data === null)
        {
            return null;
        }
        if ((data.length >= 4) &&
            (data[0] === PROTOCOL_VERSION) &&
            (data[3] === pkt))
        {
            return data;
        }
    }
}

module.exports = class extends Duplex
{
    constructor(Model, uplink, downlink)
    {
        super({ objectMode: true });

        this._SessionKeys = class extends Model {
            static get tableName() { return 'SessionKeys' };
            static get idColumn() { return 'DevAddr' };
        };

        this._count = 0;
        this._pending = [];
        this._reading = false;

        downlink.on('finish', () =>
        {
            this.end();
        });

        this._uplink_out = aw.createWriter(uplink);
        this._downlink_out = aw.createWriter(downlink);

        let ack = (data, _, cb) =>
        {
            if ((data.length >= 4) && (data[0] === PROTOCOL_VERSION))
            {
                let type = data[3];

                if (type === pkts.PUSH_DATA)
                {
                    this._uplink_out.writeAsync(Buffer.concat([
                        data.slice(0, 3),
                        Buffer.from([pkts.PUSH_ACK])]));
                }
                else if (type === pkts.PULL_DATA)
                {
                    this._downlink_out.writeAsync(Buffer.concat([
                        data.slice(0, 3),
                        Buffer.from([pkts.PULL_ACK])]));
                }
            }

            cb(null, data);
        };

        this._uplink_in = aw.createReader(uplink.pipe(
            new Transform({ transform: ack })));
        this._downlink_in = aw.createReader(downlink.pipe(
            new Transform({ transform: ack })));

        (async () =>
        {
            try
            {
                await wait_for(this._downlink_in, pkts.PULL_DATA);
                this.emit('ready');
            }
            catch (ex)
            {
                process.nextTick(() => this.emit('error', ex));
            }
        })();
    }

    _read()
    {
        if (this._reading) { return; }
        (async () =>
        {
            try
            {
                let msg;
                while ((msg = this._pending.pop()) !== undefined)
                {
                    if (!this.push(msg))
                    {
                        return;
                    }
                }

                while (true)
                {
                    let packet = await wait_for(this._uplink_in, pkts.PUSH_DATA);
                    if (packet === null)
                    {
                        return this.push(null);
                    }
                    let payload = JSON.parse(packet.slice(12));
                    if (!payload.rxpk)
                    {
                        continue;
                    }
                    while ((msg = payload.rxpk.pop()) !== undefined)
                    {
                        let data = Buffer.from(msg.data, 'base64');
                        let decoded = lora_packet.fromWire(data);
                        let buffers = decoded.getBuffers();

                        const skeys = await this._SessionKeys
                            .query()
                            .findById(buffers.DevAddr);

                        if (!skeys)
                        {
                            continue;
                        }

                        if (!lora_packet.verifyMIC(decoded, skeys.NwkSKey))
                        {
                            this.emit('verify_mic_failed', skeys, decoded);
                            continue;
                        }

                        // TODO: OTAA, check if this is a join message

                        if (!this.push(
                        {
                            msg: msg,
                            packet: decoded,
                            dev_addr: buffers.DevAddr,
                            payload: lora_packet.decrypt(decoded,
                                                         skeys.AppSKey,
                                                         skeys.NwkSKey),
                            reply: {
                                header: {
                                    tmst: msg.tmst + 1000000, // first receive window (1s)
                                    freq: msg.freq,
                                    rfch: 0, // only 0 can transmit
                                    modu: msg.modu,
                                    datr: msg.datr,
                                    codr: msg.codr,
                                    ipol: true,
                                },
                                encoding: {
                                    MType: 'Unconfirmed Data Down',
                                    DevAddr: buffers.DevAddr,
                                    FCtrl: {
                                        ADR: false,
                                        ACK: false,
                                        ADRACKReq: false,
                                        FPending: false
                                    },
                                    FPort: 1
                                }
                            }
                        }))
                        {
                            this._pending = payload.rxpk;
                            return;
                        }
                    }
                }
            }
            catch (ex)
            {
                this.emit('error', ex);
            }
            finally
            {
                this._reading = false;
            }
        })();
    }

    _write(data, encoding, cb)
    {
        (async () =>
        {
            try
            {
                const skeys = await this._SessionKeys
                    .query()
                    .findById(data.encoding.DevAddr);

                if (!skeys)
                {
                    return cb(new Error('no session keys for device'));
                }

                let encoded = lora_packet.fromFields(Object.assign(
                {
                    payload: data.payload,
                    FCnt: this._count++
                }, data.encoding), skeys.AppSKey, skeys.NwkSKey);

                let payload = encoded.getPHYPayload();

                let header = Buffer.alloc(4);
                header[0] = PROTOCOL_VERSION;
                crypto.randomFillSync(header, 1, 2);
                header[3] = pkts.PULL_RESP;

                let txpk = Object.assign(
                {
                    data: payload.toString('base64'),
                    size: payload.length
                }, data.header);

                await this._downlink_out.writeAsync(Buffer.concat([
                    header,
                    Buffer.from(JSON.stringify({txpk: txpk}))]));

                let tx_ack = await wait_for(this._downlink_in, pkts.TX_ACK);
                if ((tx_ack[1] !== header[1]) ||
                    (tx_ack[2] !== header[2]))
                {
                    return cb(new Error('TX_ACK token mismatch'));
                }

                cb();
            }
            catch (ex)
            {
                cb(ex);
            }
        })();
    }
};
