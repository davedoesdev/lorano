exports.up = async knex => {
    await knex.schema
        .createTable('ABPSessions', table => {
            table.binary('DevAddr', 4)
                 .primary()
                 .notNullable();
            table.binary('NwkSKey', 16)
                 .notNullable();
            table.binary('AppSKey', 16)
                 .notNullable();
        });
};

exports.down = async knex => {
    await knex.schema
        .dropTableIfExists('ABPSessions');
};
