let kf = require('../knexfile');
kf.development.connection.filename = './lorano.sqlite3';
module.exports = kf;
