'use strict';

// Load modules

const Lab = require('lab');
const Code = require('code');
const Hapi = require('hapi');
const Joi = require('joi');
const Hoek = require('hoek');
const Path = require('path');
const Fs = require('fs');
const Tmp = require('tmp');
const Objection = require('objection');
const Knex = require('knex');
const TestModels = require('./models');
const Schwifty = require('..');

// Test shortcuts

const lab = exports.lab = Lab.script();
const expect = Code.expect;
const describe = lab.describe;
const before = lab.before;
const it = lab.it;

describe('Schwifty', () => {

    const getOptions = (extras) => {

        const options = {
            knex: {
                client: 'sqlite3',
                useNullAsDefault: true,
                connection: {
                    filename: ':memory:'
                }
            }
        };

        return Hoek.applyToDefaults(options, extras || {});
    };

    const makeKnex = () => {

        return Knex({
            client: 'sqlite3',
            useNullAsDefault: true,
            connection: {
                filename: ':memory:'
            },
            migrations: {
                tableName: 'TestMigrations'
            }
        });
    };

    const basicKnexConfig = {
        client: 'sqlite3',
        useNullAsDefault: true
    };

    const getServer = async (options) => {

        const server = Hapi.server();

        await server.register({
            plugin: Schwifty,
            options
        });

        return server;

    };

    const modelsFile = './models/as-file.js';

    const state = (server) => {

        return server.realm.plugins.schwifty;
    };

    before(() => {

        require('sqlite3'); // Just warm-up sqlite, so that the tests have consistent timing

    });

    it('connects models to knex instance during onPreStart.', async () => {

        const config = getOptions({
            models: [
                TestModels.Dog,
                TestModels.Person
            ]
        });

        const server = await getServer(config);

        expect(server.models().Dog.$$knex).to.not.exist();
        expect(server.models().Person.$$knex).to.not.exist();

        await server.initialize();

        expect(server.models().Dog.$$knex).to.exist();
        expect(server.models().Person.$$knex).to.exist();

    });

    it('tears-down connections onPostStop.', async () => {

        const server = await getServer(getOptions());
        let toredown = 0;

        expect(toredown).to.equal(0);

        await server.knex().destroy();
        ++toredown;

        await server.stop();

        expect(toredown).to.equal(1);

    });


    it('tears-down all connections onPostStop.', async () => {

        const server = await getServer(getOptions());

        let toredown = 0;

        await server.initialize();
        expect(toredown).to.equal(0);

        const plugin1 = {
            name: 'plugin-one',
            register: (srv, opts) => {

                // Creates plugin-specific knex instance using the base connection configuration specified in getOptions
                srv.schwifty(getOptions({
                    models: [
                        TestModels.Dog,
                        TestModels.Person
                    ]
                }));

                // Monkeypatch the destroy func
                const oldDestroy = srv.knex().destroy;
                srv.knex().destroy = () => {

                    ++toredown;
                    // Returns a Promise, which is await'd in lib/index::internals.stop
                    return oldDestroy();
                };

            }
        };

        const plugin2 = {
            name: 'plugin-two',
            register: (srv, opts) => {

                srv.schwifty([TestModels.Zombie]);

                // Plugin 2 will use server.root's knex connection
                // Referencing server.knex() is a bit of a hacky though required workaround to to inspect the root server's knex() decoration, given that hapi17 removed server.root ( this test previously used srv.root.knex() )
                // In this case, because we can be certain that server is the root server for plugin2, we can also be certain that this comparison will work. There is no guarantee such referencing will work in
                // scenarios even slightly more complicated than this
                expect(srv.knex()).to.shallow.equal(server.knex());

            }
        };

        const oldDestroy = server.knex().destroy;
        server.knex().destroy = () => {

            ++toredown;
            return oldDestroy();
        };

        await server.register([plugin1, plugin2]);
        await server.initialize();
        await server.stop();
        // 2 pools were destroyed, plugin2 shared knex with the server root
        expect(toredown).to.equal(2);

    });

    it('does not tear-down connections onPostStop with option `teardownOnStop` false.', async () => {

        const options = getOptions({ teardownOnStop: false });
        const server = await getServer(options);
        let toredown = 0;

        await server.initialize();
        expect(toredown).to.equal(0);

        server.ext('onPreStop', (srv) => {

            // Monkeypatch the destroy func
            const oldDestroy = srv.knex().destroy;
            srv.knex().destroy = () => {

                ++toredown;
                return oldDestroy();
            };

            expect(server.knex()).to.exist();
        });

        await server.stop();
        expect(toredown).to.equal(0);

    });

    it('can be registered multiple times.', async () => {

        const server = await getServer(getOptions({
            models: [
                TestModels.Dog,
                TestModels.Person
            ]
        }));

        expect(server.registrations.schwifty).to.exist();

        await server.register({
            plugin: Schwifty,
            options: { models: [TestModels.Movie, TestModels.Zombie] }
        });

        expect(Object.keys(server.models())).to.only.contain([
            'Dog',
            'Person',
            'Movie',
            'Zombie'
        ]);

    });

    describe('plugin registration', () => {

        it('takes `models` option as a relative path.', async () => {

            const options = getOptions({ models: Path.normalize('./test/' + modelsFile) });
            const server = await getServer(options);
            const models = server.models();

            expect(models.Dog).to.exist();
            expect(models.Person).to.exist();

        });

        it('takes `models` option as an absolute path.', async () => {

            const options = getOptions({ models: Path.normalize(__dirname + '/' + modelsFile) });
            const server = await getServer(options);
            const models = server.models();

            expect(models.Dog).to.exist();
            expect(models.Person).to.exist();

        });

        it('takes `models` option respecting server.path().', async () => {

            const server = Hapi.server();
            server.path(__dirname);

            await server.register({
                plugin: Schwifty,
                options: getOptions({ models: modelsFile })
            });

            const models = server.models();

            expect(models.Dog).to.exist();
            expect(models.Person).to.exist();

        });

        it('takes `models` option as an array of objects.', async () => {

            const options = getOptions({
                models: [
                    TestModels.Dog,
                    TestModels.Person
                ]
            });

            const server = await getServer(options);
            const models = server.models();

            expect(models.Dog).to.exist();
            expect(models.Person).to.exist();

        });

        it('throws if the `models` option is not an array or string.', async () => {

            const options = getOptions({ models: {} });
            // We check the message against a regex because it also contains info on the server's knex connection and models, which are impractical / impossible to match exactly via string
            await expect(getServer(options)).to.reject(null, /^Bad plugin options passed to schwifty\./);

        });

        it('throws when `teardownOnStop` is specified more than once.', async () => {

            const options = getOptions({ teardownOnStop: false });
            const server = await getServer(options);
            const plugin = {
                name: 'my-plugin',
                register: async (srv, opts) => {

                    await srv.register({ options, plugin: Schwifty });
                }
            };

            await expect(server.register(plugin)).to.reject(null, 'Schwifty\'s teardownOnStop option can only be specified once.');

        });

        it('throws when `migrateOnStart` is specified more than once.', async () => {

            const server = await getServer({ migrateOnStart: false });
            const plugin = {
                name: 'my-plugin',
                register: async (srv, opts) => {

                    await srv.register({ plugin: Schwifty, options: { migrateOnStart: false } });
                }
            };

            await expect(server.register(plugin)).to.reject(null, 'Schwifty\'s migrateOnStart option can only be specified once.');

        });

        it('throws when multiple knex instances passed to same server.', async () => {

            const server = await getServer({ knex: Knex(basicKnexConfig) });

            await expect(server.register({
                plugin: Schwifty,
                options: { knex: Knex(basicKnexConfig) }
            })).to.reject(null, 'A knex instance/config may be specified only once per server or plugin.');

        });
    });

    describe('server.schwifty() decoration', () => {

        it('aggregates models across plugins.', (done) => {

            const options = getOptions({
                models: [
                    TestModels.Dog,
                    TestModels.Person
                ]
            });

            getServer(options, (err, server) => {

                expect(err).to.not.exist();

                const plugin1 = (srv, opts, next) => {

                    srv.schwifty({
                        models: [TestModels.Movie]
                    });
                    next();
                };

                plugin1.attributes = { name: 'plugin-one' };

                const plugin2 = (srv, opts, next) => {

                    srv.schwifty({
                        models: [TestModels.Zombie]
                    });
                    next();
                };

                plugin2.attributes = { name: 'plugin-two' };

                server.register([plugin1, plugin2], (err) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        // Grab all models across plugins by passing true here:
                        const models = server.models(true);

                        expect(models.Dog.tableName).to.equal('Dog');
                        expect(models.Person.tableName).to.equal('Person');
                        expect(models.Zombie.tableName).to.equal('Zombie');
                        expect(models.Movie.tableName).to.equal('Movie');

                        done();
                    });
                });
            });
        });

        it('aggregates model definitions within a plugin.', (done) => {

            getServer(getOptions({
                models: [
                    TestModels.Dog,
                    TestModels.Person
                ]
            }), (err, server) => {

                expect(err).to.not.exist();

                const rootState = state(server.root);
                expect(Object.keys(rootState.collector.models)).to.equal(['Dog', 'Person']);

                const plugin = (srv, opts, next) => {

                    srv.schwifty({
                        models: [TestModels.Movie]
                    });
                    srv.schwifty({
                        models: [TestModels.Zombie]
                    });

                    srv.app.myState = state(srv);
                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        expect(server.app.myState.knexGroup.models).to.equal(['Movie', 'Zombie']);

                        expect(Object.keys(rootState.collector.models)).to.only.contain([
                            'Dog',
                            'Person',
                            'Movie',
                            'Zombie'
                        ]);

                        done();
                    });
                });
            });
        });

        it('accepts a single model definition.', (done) => {

            getServer(getOptions(), (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.schwifty(TestModels.Zombie);
                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    const collector = state(server).collector;
                    expect(collector.models.Zombie).to.exist();

                    done();
                });
            });
        });

        it('accepts `knex` as a knex instance.', (done) => {

            const options = getOptions();
            delete options.knex;

            getServer(options, (err, server) => {

                expect(err).to.not.exist();

                const knex = Knex(basicKnexConfig);

                const plugin = (srv, opts, next) => {

                    srv.schwifty({ knex });
                    expect(srv.knex()).to.shallow.equal(knex);
                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                server.register(plugin, done);
            });
        });

        it('throws on invalid config.', (done) => {

            getServer(getOptions(), (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    expect(() => {

                        srv.schwifty({ invalidProp: 'bad' });
                    }).to.throw(/\"invalidProp\" is not allowed/);

                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();
                    done();
                });
            });
        });

        it('throws on model name collision.', (done) => {

            getServer(getOptions({
                models: [
                    TestModels.Dog,
                    TestModels.Person
                ]
            }), (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.schwifty(TestModels.Dog);
                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                expect(() => {

                    server.register(plugin, () => {

                        throw new Error('Should not make it here.');
                    });
                }).to.throw('Model "Dog" has already been registered.');

                done();
            });
        });

        it('throws when multiple knex instances passed to same plugin.', (done) => {

            getServer({}, (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.schwifty({ knex: Knex(basicKnexConfig) });

                    expect(() => {

                        srv.schwifty({ knex: Knex(basicKnexConfig) });
                    }).to.throw('A knex instance/config may be specified only once per server or plugin.');

                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                server.register(plugin, done);
            });
        });
    });

    describe('request.knex() and server.knex() decorations', () => {

        it('returns root server\'s knex instance by default.', (done) => {

            const knex = makeKnex();

            getServer({ knex }, (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.route({
                        path: '/plugin',
                        method: 'get',
                        handler: (request, reply) => {

                            expect(request.knex()).to.shallow.equal(knex);
                            reply({ ok: true });
                        }
                    });

                    expect(srv.knex()).to.shallow.equal(knex);
                    next();
                };

                plugin.attributes = { name: 'plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    // Root server's knex
                    expect(server.knex()).to.shallow.equal(knex);

                    server.inject('/plugin', (res) => {

                        expect(res.result).to.equal({ ok: true });
                        done();
                    });
                });
            });
        });

        it('returns plugin\'s knex instance over root server\'s.', (done) => {

            const knex1 = makeKnex();
            const knex2 = makeKnex();

            getServer({ knex: knex1 }, (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.schwifty({ knex: knex2 });

                    srv.route({
                        path: '/plugin',
                        method: 'get',
                        handler: (request, reply) => {

                            expect(request.knex()).to.shallow.equal(knex2);
                            reply({ ok: true });
                        }
                    });

                    expect(srv.knex()).to.shallow.equal(knex2);
                    next();
                };

                plugin.attributes = { name: 'plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    // Root server's knex
                    expect(server.knex()).to.shallow.equal(knex1);

                    server.inject('/plugin', (res) => {

                        expect(res.result).to.equal({ ok: true });
                        done();
                    });
                });
            });
        });

        it('returns null when there are no plugin or root knex instances.', (done) => {

            getServer({}, (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.route({
                        path: '/plugin',
                        method: 'get',
                        handler: (request, reply) => {

                            expect(request.knex()).to.equal(null);
                            reply({ ok: true });
                        }
                    });

                    expect(srv.knex()).to.equal(null);
                    next();
                };

                plugin.attributes = { name: 'plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    // Root server's non-knex
                    expect(server.knex()).to.equal(null);

                    server.inject('/plugin', (res) => {

                        expect(res.result).to.equal({ ok: true });
                        done();
                    });
                });
            });
        });
    });

    describe('server initialization', () => {

        it('binds knex instances to models.', (done) => {

            const knex = makeKnex();

            getServer({ knex, models: [TestModels.Person] }, (err, server) => {

                expect(err).to.not.exist();

                expect(server.models().Person.knex()).to.not.exist();

                server.initialize((err) => {

                    expect(err).to.not.exist();

                    expect(server.models().Person.knex()).to.shallow.equal(knex);

                    done();
                });
            });
        });

        it('binds root knex instance to plugins\' models by default.', (done) => {

            const knex = makeKnex();

            getServer({ knex }, (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.schwifty(TestModels.Person);
                    next();
                };

                plugin.attributes = { name: 'plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    expect(server.models(true).Person.knex()).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        expect(server.models(true).Person.knex()).to.shallow.equal(knex);

                        done();
                    });
                });
            });
        });

        it('binds plugins\' knex instance to plugins\' models over roots\'.', (done) => {

            const knex1 = makeKnex();
            const knex2 = makeKnex();

            getServer({ knex: knex1 }, (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.schwifty({ knex: knex2, models: [TestModels.Person] });
                    next();
                };

                plugin.attributes = { name: 'plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    expect(server.models(true).Person.knex()).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        expect(server.models(true).Person.knex()).to.shallow.equal(knex2);

                        done();
                    });
                });
            });
        });

        it('does not bind knex instance to models when there are no plugin or root knex instances.', (done) => {

            getServer({}, (err, server) => {

                expect(err).to.not.exist();

                const plugin = (srv, opts, next) => {

                    srv.schwifty(TestModels.Person);
                    next();
                };

                plugin.attributes = { name: 'plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    expect(server.models(true).Person.knex()).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        expect(server.models(true).Person.knex()).to.not.exist();

                        done();
                    });
                });
            });
        });

        it('does not bind knex instance when model already has a knex instance.', (done) => {

            const knex1 = makeKnex();
            const knex2 = makeKnex();

            const Person = class Person extends TestModels.Person {};
            Person.knex(knex2);

            getServer({ knex: knex1, models: [Person] }, (err, server) => {

                expect(err).to.not.exist();

                expect(server.models().Person).to.shallow.equal(Person);
                expect(server.models().Person.knex()).to.shallow.equal(knex2);

                server.initialize((err) => {

                    expect(err).to.not.exist();

                    expect(server.models().Person).to.shallow.equal(Person);
                    expect(server.models().Person.knex()).to.shallow.equal(knex2);

                    done();
                });
            });
        });

        describe('bails when a knex instance is not pingable', () => {

            const failKnexWith = (knex, error) => {

                knex.queryBuilder = () => ({
                    select: () => ({
                        asCallback: (cb) => cb(error)
                    })
                });

                return knex;
            };

            it('and lists associated models in error.', (done) => {

                const knex = failKnexWith(makeKnex(), new Error());

                getServer({ knex, models: [TestModels.Dog] }, (err, server) => {

                    expect(err).to.not.exist();

                    const plugin = (srv, opts, next) => {

                        srv.schwifty(TestModels.Person);
                        next();
                    };

                    plugin.attributes = { name: 'plugin' };

                    server.register(plugin, (err) => {

                        expect(err).to.not.exist();

                        server.initialize((err) => {

                            expect(err).to.exist();
                            expect(err.message).to.startWith('Could not connect to database using schwifty knex instance for models: "Dog", "Person".');

                            done();
                        });
                    });
                });
            });

            it('and doesn\'t list associated models in error when there are none.', (done) => {

                const knex = failKnexWith(makeKnex(), new Error());

                getServer({ knex }, (err, server) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.exist();
                        expect(err.message).to.startWith('Could not connect to database using schwifty knex instance.');

                        done();
                    });
                });
            });

            it('and augments the original error\'s message.', (done) => {

                const error = new Error('Also this other thing went wrong.');
                const knex = failKnexWith(makeKnex(), error);

                getServer({ knex }, (err, server) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.exist();
                        expect(err).to.shallow.equal(error);
                        expect(err.message).to.equal('Could not connect to database using schwifty knex instance.: Also this other thing went wrong.');

                        done();
                    });
                });
            });

            it('and adds a message to the original error if it did not already have one.', (done) => {

                const error = new Error();
                const knex = failKnexWith(makeKnex(), error);

                getServer({ knex }, (err, server) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.exist();
                        expect(err).to.shallow.equal(error);
                        expect(err.message).to.equal('Could not connect to database using schwifty knex instance.');

                        done();
                    });
                });
            });

            it('and only requires one not be pingable to fail.', (done) => {

                getServer({ knex: makeKnex() }, (err, server) => {

                    expect(err).to.not.exist();

                    const error = new Error();
                    const knex = failKnexWith(makeKnex(), error);

                    const plugin = (srv, opts, next) => {

                        srv.schwifty({ knex });
                        next();
                    };

                    plugin.attributes = { name: 'plugin' };

                    server.register(plugin, (err) => {

                        expect(err).to.not.exist();

                        server.initialize((err) => {

                            expect(err).to.exist();
                            expect(err).to.shallow.equal(error);

                            done();
                        });
                    });
                });
            });
        });
    });

    describe('migrations', () => {

        it('does not run by default.', async () => {

            const server = await getServer(getOptions({
                migrationsDir: './test/migrations/basic'
            }));

            const versionPre = await server.knex().migrate.currentVersion();
            expect(versionPre).to.equal('none');

            await server.initialize();

            const versionPost = await server.knex().migrate.currentVersion();
            expect(versionPost).to.equal('none');

        });

        it('does not run when `migrateOnStart` plugin/server option is `false`.', async () => {

            const server = await getServer(getOptions({
                migrationsDir: './test/migrations/basic',
                migrateOnStart: false
            }));

            const versionPre = await server.knex().migrate.currentVersion();
            expect(versionPre).to.equal('none');

            await server.initialize();

            const versionPost = await server.knex().migrate.currentVersion();
            expect(versionPost).to.equal('none');

        });

        it('migrates to latest when `migrateOnStart` plugin/server option is `true`.', async () => {

            const server = await getServer(getOptions({
                migrationsDir: './test/migrations/basic',
                migrateOnStart: true
            }));

            const versionPre = await server.knex().migrate.currentVersion();
            expect(versionPre).to.equal('none');

            await server.initialize();

            const versionPost = await server.knex().migrate.currentVersion();
            expect(versionPost).to.equal('basic.js');

        });

        it('migrates to latest when `migrateOnStart` plugin/server option is `\'latest\'`.', async () => {

            const server = await getServer(getOptions({
                migrationsDir: './test/migrations/basic',
                migrateOnStart: 'latest'
            }));

            const versionPre = await server.knex().migrate.currentVersion();
            expect(versionPre).to.equal('none');

            await server.initialize();

            const versionPost = await server.knex().migrate.currentVersion();
            expect(versionPost).to.equal('basic.js');

        });

        it('rollsback when `migrateOnStart` plugin/server option is `\'rollback\'`.', async () => {

            const server1 = await getServer(getOptions({
                migrationsDir: './test/migrations/basic',
                migrateOnStart: true
            }));

            await server1.initialize();
            const versionPre = await server1.knex().migrate.currentVersion();
            expect(versionPre).to.equal('basic.js');

            const server2 = await getServer({
                knex: server1.knex(),
                migrationsDir: './test/migrations/basic',
                migrateOnStart: 'rollback'
            });

            expect(server1.knex()).to.shallow.equal(server2.knex());

            await server2.initialize();
            const versionPost = await server2.knex().migrate.currentVersion();
            expect(versionPost).to.equal('none');

        });

        it('accepts absolute `migrationsDir`s.', async () => {

            const server = await getServer(getOptions({
                migrationsDir: Path.join(process.cwd(), 'test/migrations/basic'),
                migrateOnStart: true
            }));

            await server.initialize();

            const version = await server.knex().migrate.currentVersion();
            expect(version).to.equal('basic.js');

        });

        it('respects server.path() when setting `migrationsDir`.', async () => {

            const server = await getServer(getOptions({
                migrateOnStart: true
            }));

            server.path(`${__dirname}/migrations`);
            server.schwifty({ migrationsDir: 'basic' });

            const versionPre = await server.knex().migrate.currentVersion();
            expect(versionPre).to.equal('none');

            await server.initialize();

            const versionPost = await server.knex().migrate.currentVersion();
            expect(versionPost).to.equal('basic.js');

        });

        it('coalesces migrations in different directories across plugins sharing knex instances.', async () => {

            // Generates an object callable by server.register
            const makePlugin = (id, knex, migrationsDir) => {

                const plugin = {
                    name: `plugin-${id}`,
                    register: (server, options) => {

                        server.schwifty({ knex, migrationsDir });
                    }
                };

                return plugin;
            };

            const knex1 = makeKnex();
            const knex2 = makeKnex();

            // Our root server uses the knex1 knex instance as its default (fallback if no plugin-specific instance)
            const server = await getServer({
                knex: knex1,
                migrateOnStart: true
            });

            const plugin1 = makePlugin(1, knex1, './test/migrations/basic');
            const plugin2 = makePlugin(2, knex2, './test/migrations/basic');
            // plugin3 will default to using knex1 as the plugin's knex instance, so we'll expect this directory's migration files to be listed for the knex1 instance
            const plugin3 = makePlugin(3, undefined, './test/migrations/extras-one');
            const plugin4 = makePlugin(4, knex2, './test/migrations/extras-two');
            const plugin5 = makePlugin(5, knex1);

            await server.register([
                plugin1,
                plugin2,
                plugin3,
                plugin4,
                plugin5
            ]);

            await server.initialize();

            const migrations1 = await knex1('TestMigrations').columns('name').orderBy('name', 'asc');
            const migrations2 = await knex2('TestMigrations').columns('name').orderBy('name', 'asc');

            const getName = (x) => x.name;

            expect(migrations1.map(getName)).to.equal(['basic.js', 'extras-one-1st.js', 'extras-one-2nd.js']);
            expect(migrations2.map(getName)).to.equal(['basic.js', 'extras-two-1st.js', 'extras-two-2nd.js']);

        });

        it('ignores non-migration files.', async () => {

            const server = await getServer(getOptions({
                migrationsDir: './test/migrations/non-migration',
                migrateOnStart: true
            }));

            await server.initialize();

            const version = await server.knex().migrate.currentVersion();
            // If 2nd-bad had run, that would be the current version, due to sort order
            expect(version).to.equal('1st-good.js');

        });

        it('bails when failing to make a temp migrations directory.', async () => {

            const server = await getServer(getOptions({
                migrationsDir: './test/migrations/basic',
                migrateOnStart: true
            }));

            // Monkey-patches Tmp.dir to simulate an error in that method
            const origTmpDir = Tmp.dir;
            Tmp.dir = (opts, cb) => {

                // Reverts Tmp.dir back to its original definition, so subsequent tests use the normal function
                Tmp.dir = origTmpDir;
                cb(new Error('Generating temp dir failed.'));
            };

            // We expect server initialization to fail with the simulated Tmp error message
            await expect(server.initialize()).to.reject(null, 'Generating temp dir failed.');

            const version = await server.knex().migrate.currentVersion();
            expect(version).to.equal('none');

        });

        it('bails when failing to read a migrations directory.', async () => {

            const server = await getServer(getOptions({
                migrationsDir: './test/migrations/basic',
                migrateOnStart: true
            }));

            // Monkey-patches Fs.readdir to simulate an error in that method
            const origReaddir = Fs.readdir;
            Fs.readdir = (opts, cb) => {

                // Reverts Fs.readdir back to its original definition, so subsequent tests use the normal function
                Fs.readdir = origReaddir;
                cb(new Error('Reading migrations dir failed.'));
            };

            await expect(server.initialize()).to.reject(null, 'Reading migrations dir failed.');

            const version = await server.knex().migrate.currentVersion();
            expect(version).to.equal('none');

        });
    });

    describe('request.models() and server.models() decorations', () => {

        it('return empty object before server initialization.', (done) => {

            getServer(getOptions(), (err, server) => {

                expect(err).not.to.exist();

                server.route({
                    path: '/',
                    method: 'get',
                    handler: (request, reply) => {

                        expect(request.models()).to.equal({});
                        expect(request.models(true)).to.equal({});
                        reply({ ok: true });
                    }
                });

                expect(server.models()).to.equal({});
                expect(server.models(true)).to.equal({});

                server.inject({ url: '/', method: 'get' }, (response) => {

                    expect(response.result).to.equal({ ok: true });
                    done();
                });
            });
        });

        it('return empty object if no models have been added.', (done) => {

            getServer(getOptions(), (err, server) => {

                expect(err).not.to.exist();

                server.route({
                    path: '/root',
                    method: 'get',
                    handler: (request, reply) => {

                        expect(request.models()).to.equal({});
                        expect(request.models(true)).to.equal({});
                        reply({ ok: 'root' });
                    }

                });

                expect(state(server).knexGroup.models).to.equal([]);

                expect(server.models()).to.equal({});
                expect(server.models(true)).to.equal({});


                // Plugin here to show that models() defaults to [] (schwifty isn't called)
                const plugin = (srv, opts, next) => {

                    srv.route({
                        path: '/plugin',
                        method: 'get',
                        handler: (request, reply) => {

                            const _knexGroupId = state(srv);
                            expect(_knexGroupId).to.not.exist();
                            const models = request.models();
                            expect(models).to.equal({});
                            reply({ ok: 'plugin' });
                        }
                    });

                    next();
                };

                plugin.attributes = { name: 'my-plugin' };


                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        server.inject({ url: '/root', method: 'get' }, (res1) => {

                            expect(res1.result).to.equal({ ok: 'root' });

                            server.inject({ url: '/plugin', method: 'get' }, (res2) => {

                                expect(res2.result).to.equal({ ok: 'plugin' });
                                done();
                            });
                        });
                    });
                });
            });
        });

        it('solely return models registered in route\'s realm by default.', (done) => {

            getServer(getOptions({
                models: [
                    TestModels.Dog,
                    TestModels.Person
                ]
            }), (err, server) => {

                expect(err).not.to.exist();

                server.route({
                    path: '/root',
                    method: 'get',
                    handler: (request, reply) => {

                        const models = request.models();
                        expect(models).to.have.length(2);
                        expect(models.Dog.tableName).to.equal('Dog');
                        expect(models.Person.tableName).to.equal('Person');
                        reply({ ok: 'root' });
                    }
                });
                server.ext('onPreStart', (_, nxt) => {

                    const models = server.models();
                    expect(models).to.have.length(2);
                    expect(models.Dog.tableName).to.equal('Dog');
                    expect(models.Person.tableName).to.equal('Person');
                    nxt();
                });

                const plugin = (srv, opts, next) => {

                    srv.schwifty(TestModels.Movie);
                    srv.route({
                        path: '/plugin',
                        method: 'get',
                        handler: (request, reply) => {

                            const models = request.models();
                            expect(models).to.have.length(1);
                            expect(models.Movie.tableName).to.equal('Movie');
                            reply({ ok: 'plugin' });
                        }
                    });
                    srv.ext('onPreStart', (_, nxt) => {

                        const models = srv.models();
                        expect(models).to.have.length(1);
                        expect(models.Movie.tableName).to.equal('Movie');
                        nxt();
                    });
                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        server.inject({ url: '/root', method: 'get' }, (res1) => {

                            expect(res1.result).to.equal({ ok: 'root' });

                            server.inject({ url: '/plugin', method: 'get' }, (res2) => {

                                expect(res2.result).to.equal({ ok: 'plugin' });
                                done();
                            });
                        });
                    });
                });
            });
        });

        it('return empty object if no models defined in route\'s realm.', (done) => {

            getServer(getOptions(), (err, server) => {

                expect(err).not.to.exist();

                const plugin = (srv, opts, next) => {

                    srv.route({
                        path: '/',
                        method: 'get',
                        handler: (request, reply) => {

                            const models = request.models();
                            expect(models).to.be.an.object();
                            expect(Object.keys(models)).to.have.length(0);
                            reply({ ok: true });
                        }
                    });
                    srv.ext('onPreStart', (_, nxt) => {

                        const models = srv.models();
                        expect(models).to.be.an.object();
                        expect(Object.keys(models)).to.have.length(0);
                        nxt();
                    });
                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        server.inject({ url: '/', method: 'get' }, (response) => {

                            expect(response.result).to.equal({ ok: true });
                            done();
                        });
                    });
                });
            });
        });

        it('return models across all realms when passed true.', (done) => {

            getServer(getOptions({
                models: [
                    TestModels.Dog,
                    TestModels.Person
                ]
            }), (err, server) => {

                expect(err).not.to.exist();

                server.route({
                    path: '/root',
                    method: 'get',
                    handler: (request, reply) => {

                        const models = request.models(true);
                        expect(models).to.have.length(3);
                        expect(models.Dog.tableName).to.equal('Dog');
                        expect(models.Person.tableName).to.equal('Person');
                        expect(models.Zombie.tableName).to.equal('Zombie');
                        reply({ ok: 'root' });
                    }
                });
                server.ext('onPreStart', (_, nxt) => {

                    const models = server.models(true);
                    expect(models).to.have.length(3);
                    expect(models.Dog.tableName).to.equal('Dog');
                    expect(models.Person.tableName).to.equal('Person');
                    expect(models.Zombie.tableName).to.equal('Zombie');
                    nxt();
                });

                const plugin = (srv, opts, next) => {

                    srv.schwifty([TestModels.Zombie]);
                    srv.route({
                        path: '/plugin',
                        method: 'get',
                        handler: (request, reply) => {

                            const models = request.models(true);
                            expect(models).to.have.length(3);
                            expect(models.Dog.tableName).to.equal('Dog');
                            expect(models.Person.tableName).to.equal('Person');
                            expect(models.Zombie.tableName).to.equal('Zombie');
                            reply({ ok: 'plugin' });
                        }
                    });
                    srv.ext('onPreStart', (_, nxt) => {

                        const models = srv.models(true);
                        expect(models).to.have.length(3);
                        expect(models.Dog.tableName).to.equal('Dog');
                        expect(models.Person.tableName).to.equal('Person');
                        expect(models.Zombie.tableName).to.equal('Zombie');
                        nxt();
                    });
                    next();
                };

                plugin.attributes = { name: 'my-plugin' };

                server.register(plugin, (err) => {

                    expect(err).to.not.exist();

                    server.initialize((err) => {

                        expect(err).to.not.exist();

                        server.inject({ url: '/root', method: 'get' }, (res1) => {

                            expect(res1.result).to.equal({ ok: 'root' });

                            server.inject({ url: '/plugin', method: 'get' }, (res2) => {

                                expect(res2.result).to.equal({ ok: 'plugin' });
                                done();
                            });
                        });
                    });
                });
            });
        });
    });

    describe('Model', () => {

        describe('$validate()', () => {

            it('validates correct schema input.', (done) => {

                const chompy = new TestModels.Zombie();

                const validateRes = chompy.$validate({
                    firstName: 'Chompy',
                    lastName: 'Chomperson'
                });

                expect(validateRes).to.equal({
                    favoriteFood: 'Tasty brains',
                    firstName: 'Chompy',
                    lastName: 'Chomperson'
                });

                done();
            });

            it('defaults to validate itself if no json passed.', (done) => {

                const chompy = new TestModels.Zombie();
                chompy.firstName = 'Chompy';

                const validateRes = chompy.$validate();

                expect(validateRes).to.equal({
                    firstName: 'Chompy',
                    favoriteFood: 'Tasty brains'
                });

                done();
            });

            it('throws Objection.ValidationError if required schema item not provided to $validate().', (done) => {

                const chompy = new TestModels.Zombie();

                expect(() => {

                    chompy.$validate({
                        lastName: 'Chomperson'
                    });
                }).to.throw(Objection.ValidationError, /\\\"firstName\\\" is required/);

                done();
            });

            it('throws Objection.ValidationError if bad types are passed.', (done) => {

                const chompy = new TestModels.Zombie();

                expect(() => {

                    chompy.$validate({
                        firstName: 'Chompy',
                        lastName: 1234
                    });
                }).to.throw(Objection.ValidationError, /\\\"lastName\\\" must be a string/);

                done();
            });

            it('throws Objection.ValidationError with multiple errors per key.', (done) => {

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object({
                            persnicketyField: Joi.string().max(1).min(10)
                        })
                        .options({
                            abortEarly: false
                        });
                    }
                };

                const instance = new Model();
                const persnickety = { persnicketyField: 'xxxxx' }; // Length of 5, bigger than max and less than min

                let error;

                try {
                    instance.$validate(persnickety);
                }
                catch (e) {
                    error = e;
                }

                expect(error).to.be.an.instanceof(Objection.ValidationError);

                expect(error.data).to.equal({
                    persnicketyField: [
                        {
                            message: '"persnicketyField" length must be less than or equal to 1 characters long',
                            keyword: 'string.max',
                            params: {
                                limit: 1,
                                value: 'xxxxx',
                                encoding: undefined,
                                key: 'persnicketyField'
                            }
                        },
                        {
                            message: '"persnicketyField" length must be at least 10 characters long',
                            keyword: 'string.min',
                            params: {
                                limit: 10,
                                value: 'xxxxx',
                                encoding: undefined,
                                key: 'persnicketyField'
                            }
                        }
                    ]
                });

                done();
            });

            it('can modify validation schema using model.$beforeValidate().', (done) => {

                let seenSchema;
                let seenJson;
                let seenOptions;

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object();
                    }

                    $beforeValidate(schema, json, options) {

                        seenSchema = schema;
                        seenJson = json;
                        seenOptions = options;

                        return schema.keys({
                            persnicketyField: Joi.string().max(1)
                        });
                    }
                };

                const instance = new Model();
                const persnickety = { persnicketyField: 'xxxxx' }; // Length of 5, bigger than max

                expect(() => instance.$validate(persnickety)).to.throw(Objection.ValidationError);
                expect(seenSchema).to.shallow.equal(Model.getJoiSchema());
                expect(seenJson).to.equal(persnickety);
                expect(seenOptions).to.equal({});

                done();
            });

            it('skips validation if model is missing joiSchema.', (done) => {

                const anythingGoes = new Schwifty.Model();

                const whateverSchema = {
                    anything: 'goes',
                    whatever: 8
                };

                expect(anythingGoes.$validate(whateverSchema)).to.equal(whateverSchema);

                done();
            });

            it('skips validation when `skipValidation` option is passed to $validate().', (done) => {

                const chompy = new TestModels.Zombie();

                const whateverSchema = {
                    anything: 'goes',
                    whatever: 8
                };

                expect(chompy.$validate(whateverSchema, { skipValidation: true })).to.equal(whateverSchema);

                done();
            });

            it('allows missing required properties when `patch` option is passed to $validate().', (done) => {

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object({
                            requiredField: Joi.any().required(),
                            hasDefault: Joi.any().default('mosdef') // should not appear after validation
                        });
                    }
                };

                const instance = new Model();
                const missingField = {};

                expect(instance.$validate(missingField, { patch: true })).to.equal(missingField);

                done();
            });
        });

        describe('static method getJoiSchema(patch)', () => {

            it('returns nothing when there\'s no Joi schema.', (done) => {

                expect(Schwifty.Model.getJoiSchema()).to.not.exist();
                expect(Schwifty.Model.getJoiSchema(true)).to.not.exist();

                done();
            });

            it('memoizes the plain schema.', (done) => {

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object();
                    }
                };

                expect(Model.getJoiSchema()).to.shallow.equal(Model.getJoiSchema());

                done();
            });

            it('memoizes the patch schema.', (done) => {

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object();
                    }
                };

                expect(Model.getJoiSchema()).to.not.shallow.equal(Model.getJoiSchema(true));
                expect(Model.getJoiSchema(true)).to.shallow.equal(Model.getJoiSchema(true));

                done();
            });

            it('forgets past memoization on extended classes.', (done) => {

                const ModelOne = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object({ a: Joi.any() });
                    }
                };

                const keysOf = (schema) => Object.keys(schema.describe().children || {});

                expect(keysOf(ModelOne.getJoiSchema())).to.only.include(['a']);
                expect(keysOf(ModelOne.getJoiSchema(true))).to.only.include(['a']);

                const ModelTwo = class extends ModelOne {
                    static get joiSchema() {

                        return super.joiSchema.keys({ b: Joi.any() });
                    }
                };

                expect(keysOf(ModelTwo.getJoiSchema())).to.only.include(['a', 'b']);
                expect(keysOf(ModelTwo.getJoiSchema(true))).to.only.include(['a', 'b']);

                done();
            });
        });

        describe('static getter jsonAttributes', () => {

            it('lists attributes that are specified as Joi objects or arrays.', (done) => {

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object({
                            arr: Joi.array(),
                            obj: Joi.object(),
                            str: Joi.string(),
                            num: Joi.number()
                        });
                    }
                };

                const jsonAttributes = Model.jsonAttributes;

                expect(jsonAttributes.length).to.equal(2);
                expect(jsonAttributes).to.contain(['arr', 'obj']);

                done();
            });

            it('returns null for a missing Joi schema.', (done) => {

                expect(Schwifty.Model.jsonAttributes).to.equal(null);

                done();
            });

            it('returns an empty array for an empty Joi schema.', (done) => {

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object();
                    }
                };

                expect(Model.jsonAttributes).to.equal([]);

                done();
            });

            it('is memoized.', (done) => {

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object({
                            arr: Joi.array(),
                            obj: Joi.object(),
                            str: Joi.string(),
                            num: Joi.number()
                        });
                    }
                };

                expect(Model.jsonAttributes).to.shallow.equal(Model.jsonAttributes);

                done();
            });

            it('if set, prefers set value.', (done) => {

                // Not affected by parent class

                Schwifty.Model.jsonAttributes = false;

                const ModelOne = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object();
                    }
                };

                expect(ModelOne.jsonAttributes).to.equal([]);

                // Prefers own set value

                const ModelTwo = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object();
                    }
                };

                ModelTwo.jsonAttributes = false;

                expect(ModelTwo.jsonAttributes).to.equal(false);

                done();
            });
        });

        describe('static setter jsonAttributes', () => {

            // A quick dip into unit (vs behavioral) testing!
            it('sets $$schwiftyJsonAttributes', (done) => {

                const Model = class extends Schwifty.Model {
                    static get joiSchema() {

                        return Joi.object({
                            arr: Joi.array(),
                            obj: Joi.object(),
                            str: Joi.string(),
                            num: Joi.number()
                        });
                    }
                };

                const jsonAttrs = Model.jsonAttributes;
                expect(jsonAttrs).to.equal(['arr', 'obj']);
                expect(jsonAttrs).to.shallow.equal(Model.$$schwiftyJsonAttributes);

                const emptyJsonAttrs = Model.jsonAttributes = [];
                expect(emptyJsonAttrs).to.shallow.equal(Model.$$schwiftyJsonAttributes);

                done();
            });
        });
    });

    describe('assertCompatible()', () => {

        const defaultErrorMsg = 'Models are incompatible.  One model must extend the other, they must have the same name, and share the same tableName.';

        it('throws if one model doesn\'t extend the other.', (done) => {

            const ModelA = class Named extends Objection.Model {};
            const ModelB = class Named extends Objection.Model {};

            expect(() => Schwifty.assertCompatible(ModelA, ModelB)).to.throw(defaultErrorMsg);
            expect(() => Schwifty.assertCompatible(ModelB, ModelA)).to.throw(defaultErrorMsg);

            done();
        });

        it('throws if one model doesn\'t have the same name as the other.', (done) => {

            const ModelA = class NameOne extends Objection.Model {};
            const ModelB = class NameTwo extends ModelA {};

            expect(() => Schwifty.assertCompatible(ModelA, ModelB)).to.throw(defaultErrorMsg);
            expect(() => Schwifty.assertCompatible(ModelB, ModelA)).to.throw(defaultErrorMsg);

            done();
        });

        it('throws if one model doesn\'t have the same table as the other.', (done) => {

            const ModelA = class Named extends Objection.Model {};
            ModelA.tableName = 'x';

            const ModelB = class Named extends ModelA {};
            ModelB.tableName = 'y';

            expect(() => Schwifty.assertCompatible(ModelA, ModelB)).to.throw(defaultErrorMsg);
            expect(() => Schwifty.assertCompatible(ModelB, ModelA)).to.throw(defaultErrorMsg);

            done();
        });

        it('throws with custom message.', (done) => {

            const ModelA = class NameOne extends Objection.Model {};
            const ModelB = class NameTwo extends ModelA {};
            const customMessage = 'Bad, very bad!';

            expect(() => Schwifty.assertCompatible(ModelA, ModelB, customMessage)).to.throw(customMessage);

            done();
        });

        it('no-ops when one model extends the other, they share the same name, and share the same table.', (done) => {

            const ModelA = class Named extends Objection.Model {};
            ModelA.tableName = 'x';

            const ModelB = class Named extends ModelA {};
            ModelB.tableName = 'x';

            expect(() => Schwifty.assertCompatible(ModelA, ModelB)).to.not.throw();
            expect(() => Schwifty.assertCompatible(ModelB, ModelA)).to.not.throw();

            done();
        });
    });
});
