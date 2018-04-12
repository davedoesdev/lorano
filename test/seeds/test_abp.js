exports.seed = async knex => {
    await knex('ABPDevices').del()
    await knex('ABPDevices').insert([
    {
        // USE YOUR OWN KEYS!
        DevAddr: Buffer.alloc(4),
        NwkSKey: Buffer.alloc(16),
        AppSKey: Buffer.alloc(16)
    }]);
};
