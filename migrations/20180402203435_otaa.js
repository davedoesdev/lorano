exports.up = async knex => {
    await knex.schema
        .createTable('OTAAKeys', table => {
            table.binary('DevEUI', 8)
                 .primary();
            table.binary('AppKey', 16);
        });
    await knex.schema
        .createTable('OTAAHistory', table => {
            table.binary('DevEUI', 8)
                 .references('DevEUI').inTable('OTAAKeys');
            table.binary('DevNonce', 2);
            table.datetime('UsedAt')
                 .defaultTo(knex.fn.now());
            table.primary(['DevEUI', 'DevNonce']);
        });
    await knex.schema
        .createTable('OTAASessions', table => {
            table.binary('DevEUI', 8)
                 .primary()
                 .references('DevEUI').inTable('OTAAKeys');
            table.binary('DevAddr', 4)
                 .references('DevAddr').inTable('SessionKeys');
        });
};

exports.down = async knex => {
    await knex.schema
        .dropTableIfExists('OTAAKeys');
    await knex.schema
        .dropTableIfExists('OTAAHistory');
    await knex.schema
        .dropTableIfExists('OTAASessions');
};
