"use strict";

module.exports = function (grunt)
{
    grunt.initConfig(
    {
        eslint: {
            target: [ 'Gruntfile.js', 'lib/**/*.js', 'test/**/*.js' ]
        },

        mochaTest: {
            src: 'test/test.js',
            options: {
                timeout: 30 * 1000
            }
        },

        exec: {
            cover: {
                cmd: "./node_modules/.bin/nyc -x Gruntfile.js -x 'test/**' node ./node_modules/.bin/grunt test"
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
                cmd: './node_modules/.bin/documentation build -c documentation.yml -f html -o docs lib/lora-comms.js'
            },

            serve_documentation: {
                cmd: './node_modules/.bin/documentation serve -w -c documentation.yml lib/lora-comms.js'
            }
        },

        copy: {
            db: {
                src: 'lorano.empty.sqlite3',
                dest: 'test/lorano.sqlite3'
            }
        }
    });

    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-mocha-test');
    grunt.loadNpmTasks('grunt-exec');
    grunt.loadNpmTasks('grunt-contrib-copy');

    grunt.registerTask('lint', 'eslint');
    grunt.registerTask('test', ['copy:db', 'mochaTest']);
    grunt.registerTask('coverage', ['exec:cover',
                                    'exec:cover_report',
                                    'exec:cover_check']);
    grunt.registerTask('coveralls', 'exec:coveralls');
    grunt.registerTask('docs', 'exec:documentation');
    grunt.registerTask('serve_docs', 'exec:serve_documentation');
    grunt.registerTask('default', ['lint', 'test']);
};
