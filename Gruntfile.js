"use strict";

const args = process.argv.filter(a => a.startsWith('--')).map(a => ` ${a}`);
// note we can't use npx mocha because npx initialises the thread pool
// before we can set UV_THREADPOOL_SIZE in lib/lora-comms.js
const test_cmd = `./node_modules/.bin/mocha --timeout 30000 --bail ${args}`;
const c8 = "npx c8 -x Gruntfile.js -x knexfile.js -x 'test/**'";

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

        exec: Object.fromEntries(Object.entries({
            seed: {
                cwd: './test',
                cmd: `../node_modules/.bin/knex seed:run -- ${args}`
            },

            test: {
                cmd: test_cmd
            },

            cover: {
                cmd: `${c8} ${test_cmd}`
            },

            cover_report: {
                cmd: `${c8} report -r lcov`
            },

            cover_check: {
                cmd: `${c8} check-coverage --statements 100 --branches 100 --functions 100 --lines 100`
            },

            documentation: {
                cmd: 'npx documentation build -c documentation.yml -f html -o docs lib/lorano.js'
            },

            run_example: {
                cmd: 'node example/example.js'
            }
        }).map(([k, v]) => [k, { stdio: 'inherit', ...v }])),

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
    grunt.loadNpmTasks('grunt-exec');
    grunt.loadNpmTasks('grunt-contrib-copy');

    grunt.registerTask('lint', 'eslint');
    grunt.registerTask('test', ['copy:test_db',
                                'exec:seed',
                                'exec:test']);
    grunt.registerTask('coverage', ['copy:test_db',
                                    'exec:seed',
                                    'exec:cover',
                                    'exec:cover_report',
                                    'exec:cover_check']);
    grunt.registerTask('example', ['copy:example_db',
                                   'exec:run_example']);
    grunt.registerTask('docs', 'exec:documentation');
    grunt.registerTask('default', ['lint', 'test']);
};

