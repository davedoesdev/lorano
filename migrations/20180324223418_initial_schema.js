exports.up = async knex => {
    await knex.schema
        .createTable('ABPDevices', table => {
            table.binary('DevAddr', 4)
                 .primary();
            table.binary('NwkSKey', 16)
                 .notNullable();
            table.binary('AppSKey', 16)
                 .notNullable();
            table.integer('FCntUp')
                 .defaultTo(0);
            table.integer('FCntDown')
                 .defaultTo(0);
        });
};

exports.down = async knex => {
    await knex.schema
        .dropTableIfExists('ABPDevices');
};
