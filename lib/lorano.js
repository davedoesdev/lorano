"use strict";

process.env.UV_THREADPOOL_SIZE = (process.env.UV_THREADPOOL_SIZE || 4) + 3;

const { Duplex, Transform } = require('stream'),
      crypto = require('crypto'),
      { transaction } = require('objection'),
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
        const data = await link.readAsync();
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

class Link extends Duplex
{
    constructor(Model, uplink, downlink, options)
    {
        // options.appid = AppEUI
        // options.netid = NetId: NwkID (7 LSB), rest chosen by network operator
        // Private NwkId: 000000 or 000001

        super(Object.assign({}, options, { objectMode: true }));

        this._options = Object.assign(
        {
            // RX1 data rate offset. Just subtracts (see below for data rates).
            // See section 7.1.7 of LoRaWAN spec.
            RX1DRoffset: 0,
            // RX2 data rate. Region-specific. EU:
            // 0 SF12 / 125kHz
            // 1 SF11 / 125kHz
            // 2 SF10 / 125kHz
            // 3 SF9 / 125kHz
            // 4 SF8 / 125kHz
            // 5 SF7 / 125kHz
            // 6 SF7 / 250kHz
            // 7 FSK: 50kbps
            // 8-15 RFU
            RX2DataRate: 0,
            // RxDelay:
            // 7-4 RFU
            // 3-0 Delay in seconds
            RXDelay: 1,
            FCntDownMax: 0xffff
        }, options);

        this._knex = Model.knex();

        this._ABPDevices = class extends Model {
            static get tableName() { return 'ABPDevices'; };
            static get idColumn() { return 'DevAddr'; };
        };

        this._OTAADevices = class extends Model {
            static get tableName() { return 'OTAADevices'; };
            static get idColumn() { return 'NwkAddr'; };
        };

        this._OTAAHistory = class extends Model {
            static get tableName() { return 'OTAAHistory'; };
            static get idColumn() { return ['DevEUI', 'DevNonce']; };
        };

        this._pending = [];
        this._reading = false;

        downlink.on('finish', () =>
        {
            this.end();
        });

        this._uplink_out = aw.createWriter(uplink);
        this._downlink_out = aw.createWriter(downlink);

        let received_first_pull_data = false;

        const ack = (data, _, cb) =>
        {
            (async () =>
            {
                if ((data.length >= 4) && (data[0] === PROTOCOL_VERSION))
                {
                    const type = data[3];

                    if (type === pkts.PUSH_DATA)
                    {
                        await this._uplink_out.writeAsync(Buffer.concat([
                            data.slice(0, 3),
                            Buffer.from([pkts.PUSH_ACK])]));
                    }
                    else if (type === pkts.PULL_DATA)
                    {
                        await this._downlink_out.writeAsync(Buffer.concat([
                            data.slice(0, 3),
                            Buffer.from([pkts.PULL_ACK])]));

                        if (received_first_pull_data)
                        {
                            return cb();
                        }
                        received_first_pull_data = true;
                    }
                }

                cb(null, data);
            })();
        };

        this._uplink_in = aw.createReader(uplink.pipe(
            new Transform({ transform: ack, highWaterMark: 0 })));
        this._downlink_in = aw.createReader(downlink.pipe(
            new Transform({ transform: ack, highWaterMark: 0 })));

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
        this._reading = true;
        (async () =>
        {
            try
            {
                while (true)
                {
                    // Process each message we last read
                    let msg;
                    while ((msg = this._pending.shift()) !== undefined)
                    {
                        // Decode message data
                        const data = Buffer.from(msg.data, 'base64');
                        const decoded = lora_packet.fromWire(data);
                        
                        // OTAA join
                        if (decoded.isJoinRequestMessage())
                        {
                            await this._join(msg, decoded);
                        }
                        // Data
                        else if (decoded.isDataMessage() &&
                                 (decoded.getDir() === 'up') &&
                                 !await this._data(msg, decoded))
                        {
                            return;
                        }
                    }

                    // Read incoming packet
                    const packet = await wait_for(this._uplink_in, pkts.PUSH_DATA);
                    if (packet === null)
                    {
                        return this.push(null);
                    }

                    // Parse packet data (JSON-encoded by shared pkt forwarder)
                    const payload = JSON.parse(packet.slice(12));
                    if (payload.rxpk)
                    {
                        this._pending = payload.rxpk;
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

    _write(data, _, cb)
    {
        (async () =>
        {
            try
            {
                const encoded = data.encoded || await transaction(this._knex, async trx =>
                {
                    const device = await this._device(data.encoding.DevAddr, trx);
                    if (!device)
                    {
                        // we don't know this device
                        throw new Error('unknown device');
                    }
                    if (!device.NwkSKey || !device.AppSKey)
                    {
                        // can't be abp because abp keys aren't nullable
                        throw new Error('device not joined');
                    }

                    if (device.FCntDown > this._options.FCntDownMax)
                    {
                        throw new Error('send frame count exceeded');
                    }

                    await this._patch_device(
                        device, { FCntDown: device.FCntDown + 1 }, trx);

                    return lora_packet.fromFields(Object.assign(
                    {
                        payload: data.payload,
                        FCnt: device.FCntDown
                    }, data.encoding), device.AppSKey, device.NwkSKey);
                });

                const payload = encoded.getPHYPayload();

                const header = Buffer.alloc(4);
                header[0] = PROTOCOL_VERSION;
                crypto.randomFillSync(header, 1, 2);
                header[3] = pkts.PULL_RESP;

                const txpk = Object.assign(
                {
                    data: payload.toString('base64'),
                    size: payload.length
                }, data.header);

                await this._downlink_out.writeAsync(Buffer.concat([
                    header,
                    Buffer.from(JSON.stringify({txpk: txpk}))]));

                const tx_ack = await wait_for(this._downlink_in, pkts.TX_ACK);
                if ((tx_ack !== null) &&
                    ((tx_ack[1] !== header[1]) ||
                     (tx_ack[2] !== header[2])))
                {
                    throw new Error('TX_ACK token mismatch');
                }

                cb();
            }
            catch (ex)
            {
                cb(ex);
            }
        })();
    }

    _header(msg, delay)
    {
        return {
            tmst: msg.tmst + delay,
            freq: msg.freq,
            rfch: 0, // only 0 can transmit
            modu: msg.modu,
            datr: msg.datr,
            codr: msg.codr,
            ipol: true
        };
    }

    async _patch_device(device, data, trx)
    {
        if (device.NwkAddr)
        {
            await this._OTAADevices
                .query(trx)
                .patch(data)
                .where('NwkAddr', device.NwkAddr);
        }
        else
        {
            await this._ABPDevices
                .query(trx)
                .patch(data)
                .where('DevAddr', device.DevAddr);
        }
    }

    async _join(msg, decoded)
    {
        // Check OTAA join request is for this app
        const buffers = decoded.getBuffers();
        if (!buffers.AppEUI.equals(this._options.appid))
        {
            return;
        }

        // Check if we know this device
        const device = await this._deveui_to_otaa_device(buffers.DevEUI);
        if (!device)
        {
            return;
        }

        // Verify request
        if (!lora_packet.verifyMIC(decoded, null, device.AppKey))
        {
            return this.emit('verify_mic_failed', device, decoded);
        }

        // Check for replay
        try
        {
            await this._OTAAHistory
                .query()
                .insert(
                {
                    DevEUI: buffers.DevEUI,
                    DevNonce: buffers.DevNonce
                });
        }
        catch (ex)
        {
            return this.emit('join_replay', device, decoded, ex);
        }

        // Make AppNonce
        const app_nonce = crypto.randomBytes(3);

        // Make NwkSKey
        const nwk_skey = this._skey(device.AppKey,
                                    0x01,
                                    app_nonce,
                                    buffers.DevNonce);

        // Make AppSKey
        const app_skey = this._skey(device.AppKey,
                                    0x02,
                                    app_nonce,
                                    buffers.DevNonce);

        // Make DevAddr
        const dev_addr = this.nwk_addr_to_dev_addr(device.NwkAddr);
        
        // Allow subclass to customise Join Accept message
        const data = await this._join_data(
        {
            msg: msg,
            packet: decoded,
            nwk_addr: device.NwkAddr,
            dev_eui: device.DevEUI,
            dev_addr: dev_addr,
            reply: {
                header: this._header(msg, 5000000), // JOIN_ACCEPT_DELAY1 (5s)
                encoding: {
                    MType: 'Join Accept',
                    AppNonce: app_nonce,
                    NetID: this._options.netid,
                    DevAddr: dev_addr,
                    // DLSettings:
                    // 7 RFU (reserved)
                    // 6-4 RX1DRoffset
                    // 3-0 RX2 data rate (same as LinkADRReq in spec)
                    DLSettings: (this._options.RX1DRoffset << 4) |
                                this._options.RX2DataRate,
                    RXDelay: this._options.RXDelay
                    // CFList (optional, none given here):
                    // Frequences of channels 4-8
                    // Each 3 bytes (24 bit, freq in Hz / 100), unused is 0
                    // Followed by 1 RFU byte
                }
            }
        });

        // Encode Join Accept message
        data.encoded = lora_packet.fromFields(
            data.encoding, app_skey, nwk_skey, device.AppKey);

        // Save keys
        await this._OTAADevices
            .query()
            .patch(
            {
                NwkSKey: nwk_skey,
                AppSKey: app_skey,
                FCntUp: 0,
                FCntDown: 0
            })
            .where('NwkAddr', device.NwkAddr);

        // Send Join Accept message
        this.write(data);
    }

    async _data(msg, decoded)
    {
        return await transaction(this._knex, async trx =>
        {
            const buffers = decoded.getBuffers();
            const device = await this._device(buffers.DevAddr, trx);
            if (!device)
            {
                // we don't know this device
                return true;
            }
            if (!device.NwkSKey || !device.AppSKey)
            {
                // can't be abp because abp keys aren't nullable
                this.emit('not_joined', device, decoded);
                return true;
            }

            if (!lora_packet.verifyMIC(decoded, device.NwkSKey))
            {
                this.emit('verify_mic_failed', device, decoded);
                return true;
            }

            const fcnt = decoded.getFCnt();
            if (fcnt < device.FCntUp)
            {
                this.emit('data_replay', device, decoded);
                return true;
            }

            await this._patch_device(device, { FCntUp: fcnt + 1 }, trx)

            return this.push(
            {
                msg: msg,
                packet: decoded,
                nwk_addr: device.NwkAddr,
                dev_eui: device.DevEUI,
                dev_addr: buffers.DevAddr,
                payload: lora_packet.decrypt(decoded, device.AppSKey, device.NwkSKey),
                reply: {
                    header: this._header(msg, 1000000), // RECEIVE_DELAY1 (1s)
                    encoding: {
                        MType: 'Unconfirmed Data Down',
                        DevAddr: buffers.DevAddr,
                        FCtrl: {
                            ADR: false,
                            ADRACKReq: false,
                            ACK: decoded.getMType() === 'Confirmed Data Up',
                            FPending: false
                        },
                        FPort: 1
                    }
                }
            });
        });
    }

    _skey(app_key, type, app_nonce, dev_nonce)
    {
        return Link.skey(this._options.netid, app_key, type, app_nonce, dev_nonce);
    }

    async _device(dev_addr, trx)
    {
        const device = await this._dev_addr_to_otaa_device(dev_addr, trx);
        if (device)
        {
            return device;
        }
        return await this._ABPDevices
                        .query(trx)
                        .findById(dev_addr);
    }

    async _join_data(data)
    {
        return data.reply;
    }

    nwk_addr_to_dev_addr(nwk_addr)
    {
        const dev_addr = Buffer.from(nwk_addr);
        // 7 msb of DevAddr match 7 lsb of netid (NwkID)
        dev_addr[0] &= 0x1;
        dev_addr[0] |= (this._options.netid[2] & 0x7f) << 1;
        return dev_addr;
    }

    dev_addr_to_nwk_addr(dev_addr)
    {
        // Check if from OTAA device on this network
        // (7 msb of DevAddr match 7 lsb of netid (NwkID))
        if ((dev_addr[0] >> 1) === (this._options.netid[2] & 0x7f))
        {
            const nwk_addr = Buffer.from(dev_addr);
            nwk_addr[0] &= 0x01;
            return nwk_addr
        }
        return null;
    }

    async _dev_addr_to_otaa_device(dev_addr, trx)
    {
        const nwk_addr = this.dev_addr_to_nwk_addr(dev_addr);
        if (nwk_addr)
        {
            // OTAA device
            return await this._OTAADevices
                        .query(trx)
                        .findById(nwk_addr);
        }
        return null;
    }

    async _deveui_to_otaa_device(deveui)
    {
        return await this._OTAADevices 
                    .query()
                    .findOne('DevEUI', deveui);
    }

    async dev_addr_to_deveui(dev_addr)
    {
        const device = await this._dev_addr_to_otaa_device(dev_addr)
        if (device)
        {
            return device.DevEUI;
        }
        return null;
    }
}

// For testing
Link.skey = function (netid, app_key, type, app_nonce, dev_nonce)
{
    const cipher = crypto.createCipheriv('aes-128-ecb', app_key, '');
    cipher.setAutoPadding(false);

    const skey = [];
    const update = buf =>
    {
        // The octet order for all multi-octet fields is little endian
        for (let i = buf.length - 1; i >= 0; i -= 1)
        {
            skey.push(cipher.update(buf.slice(i, i + 1)));
        }
    };

    update(Buffer.from([type]));
    update(app_nonce);
    update(netid);
    update(dev_nonce);
    update(Buffer.alloc(7));
    skey.push(cipher.final());

    return Buffer.concat(skey);
};

module.exports = Link;
