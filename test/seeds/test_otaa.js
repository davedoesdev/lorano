const crypto = require('crypto'),
      i = process.argv.indexOf('--'),
      argv = require('yargs')(i < 0 ? process.argv : process.argv.slice(i + 1))
            .option('deveui', {
                type: 'string',
                coerce: arg => Buffer.from(arg, 'hex'),
                default: Buffer.alloc(8)
            })
            .option('appkey', {
                type: 'string',
                coerce: arg => Buffer.from(arg, 'hex'),
                default: Buffer.alloc(16)
            })
            .argv;

exports.seed = async knex => {
    await knex('OTAASessions').del();
    await knex('OTAASessions').insert(
    {
        NwkAddr: crypto.randomBytes(4),
        DevEUI: argv.deveui,
        AppKey: argv.appkey
    });
    await knex('OTAAHistory').del();
};
