exports.up = async knex => {
    await knex.schema
        .createTable('OTAASessions', table => {
            table.binary('NwkAddr', 4) // 25 lsb, 7 msb must be 0
                 .primary();
            table.binary('DevEUI', 8)
                 .unique()
                 .notNullable();
            table.binary('AppKey', 16)
                 .notNullable();
            table.binary('NwkSKey', 16);
            table.binary('AppSKey', 16);
            table.integer('FCntUp')
                 .defaultTo(0);
            table.integer('FCntDown')
                 .defaultTo(0);
        });
    await knex.schema
        .createTable('OTAAHistory', table => {
            table.binary('DevEUI', 8)
                 .references('DevEUI').inTable('OTAASessions');
            table.binary('DevNonce', 2);
            table.datetime('UsedAt')
                 .defaultTo(knex.fn.now());
            table.primary(['DevEUI', 'DevNonce']);
        });
};

exports.down = async knex => {
    await knex.schema
        .dropTableIfExists('OTAASessions');
    await knex.schema
        .dropTableIfExists('OTAAHistory');
};
