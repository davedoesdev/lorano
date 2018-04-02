exports.seed = async knex => {
    await knex('OTAAKeys').del();
    await knex('OTAAKeys').insert([
    {
        // USE YOUR OWN KEYS!
        AppEUI: Buffer.alloc(8),
        DevEUI: Buffer.alloc(8),
        AppKey: Buffer.alloc(16)
    }]);
    await knex('OTAAHistory').del();
};
