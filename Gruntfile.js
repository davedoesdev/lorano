"use strict";

let args = '';
for (const arg of process.argv)
{
    if (arg.startsWith('--'))
    {
        args += ' ' + arg;
    }
}

module.exports = function (grunt)
{
    grunt.initConfig(
    {
        eslint: {
            target: [
                'Gruntfile.js',
                'lib/**/*.js',
                'test/**/*.js',
                'example/**/*.js'
            ]
        },

        mochaTest: {
            src: 'test/test.js',
            options: {
                timeout: 30 * 1000
            }
        },

        exec: {
            seed: {
                cwd: './test',
                cmd: '../node_modules/.bin/knex seed:run --' + args
            },

            cover: {
                cmd: "./node_modules/.bin/nyc -x Gruntfile.js -x knexfile.js -x 'test/**' node ./node_modules/.bin/grunt test" + args
            },

            cover_report: {
                cmd: './node_modules/.bin/nyc report -r lcov'
            },

            cover_check: {
                cmd: './node_modules/.bin/nyc check-coverage --statements 100 --brances 100 --functions 100 --lines 100'
            },

            coveralls: {
                cmd: 'cat coverage/lcov.info | ./node_modules/.bin/coveralls'
            },

            documentation: {
                cmd: "./node_modules/.bin/documentation build -c documentation.yml -f html -o docs lib/lorano.js && sed -i 's/<p>\\(<code>reply.*\\)<\\/p>/\\1/' docs/index.html"
            }
        },

        copy: {
            test_db: {
                src: 'lorano.empty.sqlite3',
                dest: 'test/lorano.sqlite3'
            },

            example_db: {
                src: 'lorano.empty.sqlite3',
                dest: 'example/lorano.sqlite3'
            }
        }
    });

    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-mocha-test');
    grunt.loadNpmTasks('grunt-exec');
    grunt.loadNpmTasks('grunt-contrib-copy');

    grunt.registerTask('lint', 'eslint');
    grunt.registerTask('test', ['copy:test_db',
                                'exec:seed',
                                'mochaTest']);
    grunt.registerTask('coverage', ['exec:cover',
                                    'exec:cover_report',
                                    'exec:cover_check']);
    grunt.registerTask('example', ['copy:example_db',
                                   'run_example']);
    grunt.registerTask('coveralls', 'exec:coveralls');
    grunt.registerTask('docs', 'exec:documentation');
    grunt.registerTask('default', ['lint', 'test']);

    grunt.registerTask('run_example', 'run example', function ()
    {
        require('lora-comms').on('stop', this.async());
        require('./example/example');
    });
};
