High-level Node.js module for reading and writing LoRa packets, with
support for over-the-air activation (OTAA) of devices.

It uses streams supplied by
[node-lora-comms](https://github.com/davedoesdev/node-lora-comms) and
[Anthony Kirby’s excellent packet
decoder](https://github.com/anthonykirby/lora-packet).

Your application is given a single
[Duplex](https://nodejs.org/dist/latest-v9.x/docs/api/stream.html#stream_class_stream_duplex)
stream operating in object mode for reading and writing packets.
Replying to a packet typically involves just supplying a payload, though
your application can override the default transmission settings if
required.

Tested on a Raspberry Pi 3 Model B with an IMST iC880A-SPI.

API documentation is available
[here](http://rawgit.davedoesdev.com/davedoesdev/lorano/master/docs/index.html).

# Example

This program works in conjunction with a [corresponding Arduino
sketch](test/lorano_test.ino) (tested on a [SODAQ
Explorer](http://support.sodaq.com/sodaq-one/explorer/)).

It reads 12-byte packets from the LoRa radio, leaves the first 6 bytes
unchanged and randomizes the last 6 bytes. It then sends the packet back
to the radio. The Explorer does the same but randomizes the first 6 byes
it receives, leaving the last 6 bytes unchanged.

Each side then checks whether it gets back the bytes it randomized in
the previous packet it sent.

**example.js.**

``` javascript
const path = require('path');
const crypto = require('crypto');
const { Link } = require('lorano');
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
lora_comms.on('stop', () => knex.destroy());

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
        DevEUI: Buffer.from('0000000000000000', 'hex'),
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
```

First you need to modify at least `DevEUI` with the unique identifier of
your device. You can then run the example like this:

``` bash
grunt example
```

# Installation

``` bash
npm install lorano
```

# Database

In the top-level directory you’ll find a file called
`lorano.empty.sqlite3`. This contains an empty copy of the database
`lorano` uses to store information about your devices (addresses, keys,
activation state etc).

You should use a *copy* of this file in your application and pass its
location when setting up [Knex.js](http://knexjs.org/). By default the
database is SQLite but Knex.js supports many other databases. If you
want to use a different database, use the lorano
[migrations](migrations) to populate it and edit
[knexfile.js](knexfile.js) accordingly.

## Seeding device data

You need to add your devices to the database otherwise lorano will
ignore packets it receives from them.

### Over-The-Air Activation (OTAA) devices

For each of your devices, you must add a row to the `OTAADevices` table
containing the following columns:

  - `NwkAddr`: Unique network address of the device. This can be random
    as long as it’s unique. It must be a binary value 4 bytes long but
    only the 25 least significant bits are used and the 7 most
    significant must be 0.

  - `DevEUI`: Unique global device ID in the IEEE EUI64 address space.
    This must be a binary value 8 bytes long and can usually be quered
    from the hardware by calling a device API.

  - `AppKey`: The AES-128 key that you’ve assigned to the device for
    your application. This is a shared secret between your application
    and the device and is used to derive session keys specific for the
    device to encrypt and verify packets communication with it. It must
    be a binary value 16 bytes long.

An example of seeding the database for an OTAA device using Knex.js can
be found in [test/seeds/test\_otaa.js](test/seeds/test_otaa.js).

### Activation By Personalization (ABP) devices

For each of your devices, you must add a row to the `ABPDevices` table
containing the following columns:

  - `DevAddr`: The identifier of your network (7 most significant bits)
    and the unique address of the device within it (25 least significant
    bits). This must be a binary value 4 bytes long.

  - `NwkSKey`: Network session key for the device. This is a shared
    secret between your application and the device and is used to
    calculate and verify the message integrity code of data messages. It
    must be a binary value 16 bytes long.

  - `AppSKey`: Application session key for the device. This is a shared
    secret between your application and the device and it used to
    encrypt and decrypt data messages. It must be a binary value 16
    bytes long.

An example of seeding the database for an ABP device using Knex.js can
be found in [test/seeds/test\_abp.js](test/seeds/test_abp.js).

# IMST iC880A-SPI reset

If you’re using an IMST iC880A-SPI, it needs to be reset after it’s
powered up.

My iC880A-SPI is connected to a Pi via a
[backplane](https://shop.coredump.ch/product/ic880a-lorawan-gateway-backplane/)
which brings the reset line out on GPIO 25. I run the following shell
script to perform the reset:

**iC880A-SPI\_reset.sh.**

``` sh
#!/bin/sh
echo "25" > /sys/class/gpio/export
echo "out" > /sys/class/gpio/gpio25/direction
echo "1" > /sys/class/gpio/gpio25/value
sleep 5
echo "0" > /sys/class/gpio/gpio25/value
sleep 1
echo "0" > /sys/class/gpio/gpio25/value
chmod o+rw /dev/spidev0.0
```

# Test

By default, the tests simulate LoRa packets and can be run with:

``` bash
grunt test
```

If you have a LoRa device that can run
[test/lorano\_test.ino](test/lorano_test.ino) then you can pass its
DEVEUI as an argument like this:

``` bash
grunt test --deveui=XXXXXXXXXXXXXXXX
```

I’ve tested this with a SODAQ Explorer.

# Lint

``` bash
grunt lint
```

# Coverage

``` bash
grunt coverage
```

Or with a LoRa device running
[test/lorano\_test.ino](test/lorano_test.ino):

``` bash
grunt coverage --deveui=XXXXXXXXXXXXXXXX
```

[c8](https://github.com/bcoe/c8) results are available
[here](http://rawgit.davedoesdev.com/davedoesdev/lorano/master/coverage/lcov-report/index.html).

# Licence

[MIT](LICENCE)
