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

const stream = require('stream'),
      aw = require('awaitify-stream');

async function wait_for(link, pkt)
{
    while (true)
    {
        let data = await link.readAsync();
        if ((data.length >= 4) && (data[0] === PROTOCOL_VERSION))
        {
            let type = data[3];

            if (type === pkts.PUSH_DATA)
            {
                data[3] = pkts.PUSH_ACK;
                await link.writeAsync(data.slice(0, 4));
            }
            else if (type === pkts.PULL_DATA)
            {
                data[3] = pkts.PULL_ACK;
                await link.writeAsync(data.slice(0, 4));
            }

            if (type === pkt)
            {
                return data;
            }
        }
    }
}

class Link extends stream.Duplex
{
    constructor(Model, uplink, downlink)
    {
        super({ objectMode: true });

        this._SessionKeys = class extends Model {
            static get tableName() { return 'SessionKeys' };
            static get idColumn() { return 'DevAddr' };
        };

        this._pending = [];

        downlink.on('finish', () =>
        {
            this.end();
        });

        this._uplink = aw.createDuplexer(uplink);
        this._downlink = aw.createDuplexer(downlink);

        (async () =>
        {
            try
            {
                await wait_for(this._downlink, pkts.PULL_DATA);
                this.emit('ready');
            }
            catch (ex)
            {
                this.emit('error', ex);
            }
        })();
    }

    _read()
    {
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
                    let packet = await wait_for(this._uplink, pkts.PUSH_DATA);
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
                        let data = Buffer.from(rxpk.data, 'base64');
                        let decoded = lora_packet.fromWire(data);
                        let buffers = decoded.getBuffers();

                        const keys = await SessionKeys
                            .query()
                            .findById(buffers.DevAddr);
                            
                        console.log('#keys', keys);

                        // TODO: OTAA, check if this is a join message

                        //get keys for buffers.DevAddr



                        // decode msg

                        if (!this.push(pkt))
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
        })();
    }

    _write(data, encoding, cb)
    {
        (async () =>
        {
            try
            {
                // make packet
                await this._downlink.writeAsync();
                await wait_for(this._downlink, pkts.TX_ACK);
                // check token matches
                cb();
            }
            catch (ex)
            {
                cb(ex);
            }
        })();
    }
}

class LoRaNo
{
    constructor(Model, uplink, downlink)
    {
        this._link = new Link(Model, uplink, downlink);
    }

    get link()
    {
        return this._link;
    }
}

exports.LoRaNo = LoRaNo;
