
exports.up = knex => {
    return knex.schema
        .createTable('SessionKeys', table => {
            table.binary('DevAddr', 4).primary();
            table.binary('NwkSKey', 16);
            table.binary('AppSKey', 16);
        });
};

exports.down = knex => {
    return knex.schema
        .dropTableIfExists('SessionKeys');
};
