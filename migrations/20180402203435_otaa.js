
exports.up = async knex => {
    await knex.schema
        .createTable('OTAAKeys', table => {
            table.binary('AppEUI', 8);
            table.binary('DevEUI', 8);
            table.binary('AppKey', 16);
            table.primary(['AppEUI', 'DevEUI']);
        });
    await knex.schema
        .createTable('OTAAHistory', table => {
            table.binary('DevEUI', 8);
            table.binary('DevNonce', 2);
            table.datetime('UsedAt').defaultTo(knex.fn.now());
            table.primary(['DevEUI', 'DevNonce']);
        });
};

exports.down = async knex => {
    await knex.schema
        .dropTableIfExists('OTAAKeys');
    await knex.schema
        .dropTableIfExists('OTAAHistory');
};
