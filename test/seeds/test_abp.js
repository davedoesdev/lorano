exports.seed = async knex => {
    await knex('ABPSessions').del()
    await knex('ABPSessions').insert([
    {
        // USE YOUR OWN KEYS!
        DevAddr: Buffer.alloc(4),
        NwkSKey: Buffer.alloc(16),
        AppSKey: Buffer.alloc(16)
    }]);
};
