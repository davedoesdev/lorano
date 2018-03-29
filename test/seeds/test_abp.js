
exports.seed = async knex => {
    await knex('SessionKeys').del()
    await knex('SessionKeys').insert([
    {
        // USE YOUR OWN KEYS!
        DevAddr: Buffer.alloc(4),
        NwkSKey: Buffer.alloc(16),
        AppSKey: Buffer.alloc(16)
    }]);
};
