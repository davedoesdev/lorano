const path = require('path');
const crypto = require('crypto');
const Link = require('..');
const lora_comms = require('lora-comms');
const { Model } = require('objection');

// Start radio
process.on('SIGINT', lora_comms.stop);
lora_comms.start_logging();
lora_comms.log_info.pipe(process.stdout);
lora_comms.log_error.pipe(process.stderr);
lora_comms.start();

// Connect to database
const knex = require('knex')({
    client: 'sqlite3',
    useNullAsDefault: true,
    connection: {
        filename: path.join(__dirname, 'lorano.sqlite3')
    }
});
Model.knex(knex);

const link = new Link(Model, lora_comms.uplink, lora_comms.downlink, {
    // USE YOUR OWN IDS!
    appid: Buffer.alloc(8),
    netid: crypto.randomBytes(3) // 7 lsb = NwkId
});

link.on('ready', async () =>
{
    // Add device (usually you'll seed the database as a separate task)
    const nwk_addr = crypto.randomBytes(4); // 25 lsb
    nwk_addr[0] &= 0x01; // 7 msb must be 0
    await knex('OTAADevices').insert({
        // USE YOUR OWN VALUES!
        NwkAddr: nwk_addr,
        DevEUI: Buffer.from('0004A30B001F0368', 'hex'),
        AppKey: Buffer.alloc(16)
    });

    // Receive and send packets until we get a match

    const duplex = require('awaitify-stream').createDuplexer(link);
    const payload_size = 12;
    let send_payload = crypto.randomBytes(payload_size);

    while (true) {
        const recv_data = await duplex.readAsync();
        if (recv_data === null) {
            return;
        }
        if (recv_data.payload.length !== payload_size) {
            continue;
        }
        if (recv_data.payload.equals(send_payload)) {
            // Shouldn't happen because send on reverse polarity
            console.error('ERROR: Received packet we sent');
            continue;
        }

        if (recv_data.payload.compare(send_payload,
                                      payload_size/2,
                                      payload_size,
                                      payload_size/2,
                                      payload_size) === 0) {
            console.log('SUCCESS: Received matching data');
            return lora_comms.stop();
        }

        send_payload = Buffer.concat([recv_data.payload.slice(0, payload_size/2),
                                      crypto.randomBytes(payload_size/2)]);
        recv_data.reply.payload = send_payload;
        await duplex.writeAsync(recv_data.reply);
    }
});
