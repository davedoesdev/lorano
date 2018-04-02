
exports.up = async knex => {
    await knex.schema
        .createTable('SessionKeys', table => {
            table.binary('DevAddr', 4).primary();
            table.binary('NwkSKey', 16);
            table.binary('AppSKey', 16);
            table.boolean('OTAA');
        });
};

exports.down = async knex => {
    await knex.schema
        .dropTableIfExists('SessionKeys');
};
