// @flow
import type {
  BundleGraph,
  NamedBundle,
  InitialParcelOptions,
} from '@parcel/types';
import assert from 'assert';
import path from 'path';
import {
  assertBundles,
  bundle,
  run,
  overlayFS,
  inputFS,
  ncp,
  workerFarm,
} from '@parcel/test-utils';
import fs from 'fs';

function runBundle(entries = 'src/index.js', opts) {
  entries = (Array.isArray(entries) ? entries : [entries]).map(entry =>
    path.join(__dirname, 'input', entry),
  );

  return bundle(entries, {
    inputFS: overlayFS,
    disableCache: false,
    ...opts,
  });
}

type UpdateFn = (
  BundleGraph<NamedBundle>,
) => ?InitialParcelOptions | Promise<?InitialParcelOptions>;
type TestConfig = {|
  ...InitialParcelOptions,
  entries?: Array<string>,
  setup?: () => void | Promise<void>,
  update: UpdateFn,
|};

async function testCache(update: UpdateFn | TestConfig, integration) {
  // Delete cache from previous test and perform initial build
  await inputFS.rimraf(path.join(__dirname, '/input'));
  await overlayFS.rimraf(path.join(__dirname, '/input'));
  await ncp(
    path.join(__dirname, '/integration', integration ?? 'cache'),
    path.join(__dirname, '/input'),
  );
  await overlayFS.rimraf(path.join(__dirname, '/input/.parcel-cache'));
  await overlayFS.rimraf(path.join(__dirname, '/input/dist'));

  let entries;
  let options: ?InitialParcelOptions;
  if (typeof update === 'object') {
    let setup;
    ({entries, setup, update, ...options} = update);

    if (setup) {
      await setup();
    }
  }

  let b = await runBundle(entries, options);

  // update
  let newOptions = await update(b);

  // Run cached build
  b = await runBundle(entries, Object.assign({}, options, newOptions));

  return b;
}

describe.only('cache', function() {
  it('should support updating a JS file', async function() {
    let b = await testCache(async b => {
      assert.equal(await run(b), 4);
      await overlayFS.writeFile(
        path.join(__dirname, '/input/src/nested/test.js'),
        'export default 4',
      );
    });

    assert.equal(await run(b), 6);
  });

  it('should support adding a dependency', async function() {
    let b = await testCache(async b => {
      assert.equal(await run(b), 4);
      await overlayFS.writeFile(
        path.join(__dirname, '/input/src/nested/foo.js'),
        'export default 6',
      );
      await overlayFS.writeFile(
        path.join(__dirname, '/input/src/nested/test.js'),
        'export {default} from "./foo";',
      );
    });

    assert.equal(await run(b), 8);
  });

  it('should error when deleting a file', async function() {
    // $FlowFixMe
    await assert.rejects(
      async () => {
        await testCache(async () => {
          await overlayFS.unlink(
            path.join(__dirname, '/input/src/nested/test.js'),
          );
        });
      },
      {message: "Failed to resolve './nested/test' from './src/index.js'"},
    );
  });

  it('should error when starting parcel from a broken state with no changes', async function() {
    // $FlowFixMe
    await assert.rejects(async () => {
      await testCache(async () => {
        await overlayFS.unlink(
          path.join(__dirname, '/input/src/nested/test.js'),
        );
      });
    });

    // Do a third build from a failed state with no changes
    // $FlowFixMe
    await assert.rejects(
      async () => {
        await runBundle();
      },
      {message: "Failed to resolve './nested/test' from './src/index.js'"},
    );
  });

  describe('babel', function() {
    let json = config => JSON.stringify(config);
    let cjs = config => `module.exports = ${JSON.stringify(config)}`;
    // TODO: not sure how to invalidate the ESM cache in node...
    // let mjs = (config) => `export default ${JSON.stringify(config)}`;
    let configs = [
      {name: '.babelrc', formatter: json, nesting: true},
      {name: '.babelrc.json', formatter: json, nesting: true},
      {name: '.babelrc.js', formatter: cjs, nesting: true},
      {name: '.babelrc.cjs', formatter: cjs, nesting: true},
      // {name: '.babelrc.mjs', formatter: mjs, nesting: true},
      {name: 'babel.config.json', formatter: json, nesting: false},
      {name: 'babel.config.js', formatter: cjs, nesting: false},
      {name: 'babel.config.cjs', formatter: cjs, nesting: false},
      // {name: 'babel.config.mjs', formatter: mjs, nesting: false}
    ];

    let testBabelCache = async opts => {
      await workerFarm.callAllWorkers('invalidateRequireCache', [
        require.resolve('@babel/core'),
      ]);

      return testCache({
        ...opts,
        async update(...args) {
          opts.update(...args);

          // invalidate babel's caches since we're simulating a process restart
          await workerFarm.callAllWorkers('invalidateRequireCache', [
            require.resolve('@babel/core'),
          ]);
        },
      });
    };

    for (let {name, formatter, nesting} of configs) {
      describe(name, function() {
        beforeEach(async () => {
          await workerFarm.callAllWorkers('invalidateRequireCache', [
            path.join(__dirname, `/input/${name}`),
          ]);
        });

        it(`should support adding a ${name}`, async function() {
          let b = await testBabelCache({
            // Babel's config loader only works with the node filesystem
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.ncp(
                path.join(__dirname, '/integration/cache'),
                path.join(__dirname, '/input'),
              );
            },
            async update(b) {
              assert.equal(await run(b), 4);

              let contents = await overlayFS.readFile(
                b.getBundles()[0].filePath,
                'utf8',
              );
              assert(
                contents.includes('class Test'),
                'class should not be transpiled',
              );

              await inputFS.writeFile(
                path.join(__dirname, `/input/${name}`),
                formatter({
                  presets: ['@babel/preset-env'],
                }),
              );
            },
          });

          assert.equal(await run(b), 4);

          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('class Test'),
            'class should be transpiled',
          );
        });

        it(`should support updating a ${name}`, async function() {
          let b = await testBabelCache({
            // Babel's config loader only works with the node filesystem
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.ncp(
                path.join(__dirname, '/integration/cache'),
                path.join(__dirname, '/input'),
              );
              await inputFS.writeFile(
                path.join(__dirname, `/input/${name}`),
                formatter({
                  presets: [
                    ['@babel/preset-env', {targets: {esmodules: true}}],
                  ],
                }),
              );
            },
            async update(b) {
              let contents = await overlayFS.readFile(
                b.getBundles()[0].filePath,
                'utf8',
              );
              assert(
                contents.includes('class Test'),
                'class should not be transpiled',
              );

              await inputFS.writeFile(
                path.join(__dirname, `/input/${name}`),
                formatter({
                  presets: ['@babel/preset-env'],
                }),
              );

              await workerFarm.callAllWorkers('invalidateRequireCache', [
                path.join(__dirname, `/input/${name}`),
              ]);
            },
          });

          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('class Test'),
            'class should be transpiled',
          );
        });

        it(`should support deleting a ${name}`, async function() {
          let b = await testBabelCache({
            // Babel's config loader only works with the node filesystem
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.ncp(
                path.join(__dirname, '/integration/cache'),
                path.join(__dirname, '/input'),
              );
              await inputFS.writeFile(
                path.join(__dirname, `/input/${name}`),
                formatter({
                  presets: ['@babel/preset-env'],
                }),
              );
            },
            async update(b) {
              let contents = await overlayFS.readFile(
                b.getBundles()[0].filePath,
                'utf8',
              );
              assert(
                !contents.includes('class Test'),
                'class should be transpiled',
              );

              await inputFS.unlink(path.join(__dirname, `/input/${name}`));
            },
          });

          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('class Test'),
            'class should not be transpiled',
          );
        });

        it(`should support updating an extended ${name}`, async function() {
          let extendedName = '.babelrc-extended' + path.extname(name);
          let b = await testBabelCache({
            // Babel's config loader only works with the node filesystem
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.ncp(
                path.join(__dirname, '/integration/cache'),
                path.join(__dirname, '/input'),
              );
              await inputFS.writeFile(
                path.join(__dirname, `/input/${extendedName}`),
                formatter({
                  presets: [
                    ['@babel/preset-env', {targets: {esmodules: true}}],
                  ],
                }),
              );
              await inputFS.writeFile(
                path.join(__dirname, `/input/${name}`),
                formatter({
                  extends: `./${extendedName}`,
                }),
              );
              await workerFarm.callAllWorkers('invalidateRequireCache', [
                path.join(__dirname, `/input/${extendedName}`),
              ]);
            },
            async update(b) {
              let contents = await overlayFS.readFile(
                b.getBundles()[0].filePath,
                'utf8',
              );
              assert(
                contents.includes('class Test'),
                'class should not be transpiled',
              );

              await inputFS.writeFile(
                path.join(__dirname, `/input/${extendedName}`),
                formatter({
                  presets: ['@babel/preset-env'],
                }),
              );

              await workerFarm.callAllWorkers('invalidateRequireCache', [
                path.join(__dirname, `/input/${extendedName}`),
              ]);
            },
          });

          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('class Test'),
            'class should be transpiled',
          );
        });

        if (nesting) {
          it(`should support adding a nested ${name}`, async function() {
            let b = await testBabelCache({
              // Babel's config loader only works with the node filesystem
              inputFS,
              outputFS: inputFS,
              async setup() {
                await inputFS.ncp(
                  path.join(__dirname, '/integration/cache'),
                  path.join(__dirname, '/input'),
                );
              },
              async update(b) {
                assert.equal(await run(b), 4);

                let contents = await overlayFS.readFile(
                  b.getBundles()[0].filePath,
                  'utf8',
                );
                assert(
                  contents.includes('class Test'),
                  'class should not be transpiled',
                );
                assert(
                  contents.includes('class Result'),
                  'class should not be transpiled',
                );

                await inputFS.writeFile(
                  path.join(__dirname, `/input/src/nested/${name}`),
                  formatter({
                    presets: ['@babel/preset-env'],
                  }),
                );
              },
            });

            assert.equal(await run(b), 4);

            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !contents.includes('class Test'),
              'class should be transpiled',
            );
            assert(
              contents.includes('class Result'),
              'class should not be transpiled',
            );
          });

          it(`should support updating a nested ${name}`, async function() {
            let b = await testBabelCache({
              // Babel's config loader only works with the node filesystem
              inputFS,
              outputFS: inputFS,
              async setup() {
                await inputFS.ncp(
                  path.join(__dirname, '/integration/cache'),
                  path.join(__dirname, '/input'),
                );
                await inputFS.writeFile(
                  path.join(__dirname, `/input/src/nested/${name}`),
                  formatter({
                    presets: [
                      ['@babel/preset-env', {targets: {esmodules: true}}],
                    ],
                  }),
                );
                await workerFarm.callAllWorkers('invalidateRequireCache', [
                  path.join(__dirname, `/input/src/nested/${name}`),
                ]);
              },
              async update(b) {
                let contents = await overlayFS.readFile(
                  b.getBundles()[0].filePath,
                  'utf8',
                );
                assert(
                  contents.includes('class Test'),
                  'class should not be transpiled',
                );
                assert(
                  contents.includes('class Result'),
                  'class should not be transpiled',
                );

                await inputFS.writeFile(
                  path.join(__dirname, `/input/src/nested/${name}`),
                  formatter({
                    presets: ['@babel/preset-env'],
                  }),
                );

                await workerFarm.callAllWorkers('invalidateRequireCache', [
                  path.join(__dirname, `/input/src/nested/${name}`),
                ]);
              },
            });

            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !contents.includes('class Test'),
              'class should be transpiled',
            );
            assert(
              contents.includes('class Result'),
              'class should not be transpiled',
            );
          });

          it(`should support deleting a nested ${name}`, async function() {
            let b = await testBabelCache({
              // Babel's config loader only works with the node filesystem
              inputFS,
              outputFS: inputFS,
              async setup() {
                await inputFS.ncp(
                  path.join(__dirname, '/integration/cache'),
                  path.join(__dirname, '/input'),
                );
                await inputFS.writeFile(
                  path.join(__dirname, `/input/src/nested/${name}`),
                  formatter({
                    presets: ['@babel/preset-env'],
                  }),
                );
              },
              async update(b) {
                let contents = await overlayFS.readFile(
                  b.getBundles()[0].filePath,
                  'utf8',
                );
                assert(
                  !contents.includes('class Test'),
                  'class should be transpiled',
                );
                assert(
                  contents.includes('class Result'),
                  'class should not be transpiled',
                );

                await inputFS.unlink(
                  path.join(__dirname, `/input/src/nested/${name}`),
                );
              },
            });

            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('class Test'),
              'class should not be transpiled',
            );
            assert(
              contents.includes('class Result'),
              'class should not be transpiled',
            );
          });
        }
      });
    }

    describe('.babelignore', function() {
      it('should support adding a .babelignore', async function() {
        let b = await testBabelCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              path.join(__dirname, '/input'),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelrc'),
              JSON.stringify({
                presets: ['@babel/preset-env'],
              }),
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !contents.includes('class Test'),
              'class should be transpiled',
            );
            assert(
              !contents.includes('class Result'),
              'class should be transpiled',
            );

            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelignore'),
              'src/nested',
            );
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          contents.includes('class Test'),
          'class should not be transpiled',
        );
        assert(
          !contents.includes('class Result'),
          'class should be transpiled',
        );
      });

      it('should support updating a .babelignore', async function() {
        let b = await testBabelCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              path.join(__dirname, '/input'),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelrc'),
              JSON.stringify({
                presets: ['@babel/preset-env'],
              }),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelignore'),
              'src/nested',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('class Test'),
              'class should not be transpiled',
            );
            assert(
              !contents.includes('class Result'),
              'class should be transpiled',
            );

            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelignore'),
              'src',
            );
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          contents.includes('class Test'),
          'class should not be transpiled',
        );
        assert(
          contents.includes('class Result'),
          'class should not be transpiled',
        );
      });

      it('should support deleting a .babelignore', async function() {
        let b = await testBabelCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              path.join(__dirname, '/input'),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelrc'),
              JSON.stringify({
                presets: ['@babel/preset-env'],
              }),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelignore'),
              'src/nested',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('class Test'),
              'class should not be transpiled',
            );
            assert(
              !contents.includes('class Result'),
              'class should be transpiled',
            );

            await inputFS.unlink(path.join(__dirname, '/input/.babelignore'));
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(!contents.includes('class Test'), 'class should be transpiled');
        assert(
          !contents.includes('class Result'),
          'class should be transpiled',
        );
      });
    });

    describe('plugins', function() {
      it('should invalidate when plugins change versions', async function() {
        let b = await testBabelCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              path.join(__dirname, '/input'),
            );
            await inputFS.mkdirp(
              path.join(__dirname, '/input/node_modules/babel-plugin-dummy'),
            );
            await inputFS.writeFile(
              path.join(
                __dirname,
                '/input/node_modules/babel-plugin-dummy/package.json',
              ),
              JSON.stringify({
                name: 'babel-plugin-dummy',
                version: '1.0.0',
              }),
            );
            await inputFS.copyFile(
              path.join(
                __dirname,
                '/integration/babelrc-custom/babel-plugin-dummy.js',
              ),
              path.join(
                __dirname,
                '/input/node_modules/babel-plugin-dummy/index.js',
              ),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelrc'),
              JSON.stringify({
                plugins: ['babel-plugin-dummy'],
              }),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/src/index.js'),
              'console.log("REPLACE_ME")',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('hello there'),
              'string should be replaced',
            );

            let plugin = path.join(
              __dirname,
              '/input/node_modules/babel-plugin-dummy/index.js',
            );
            let source = await inputFS.readFile(plugin, 'utf8');
            await inputFS.writeFile(
              plugin,
              source.replace('hello there', 'replaced'),
            );

            await inputFS.writeFile(
              path.join(
                __dirname,
                '/input/node_modules/babel-plugin-dummy/package.json',
              ),
              JSON.stringify({
                name: 'babel-plugin-dummy',
                version: '2.0.0',
              }),
            );

            await workerFarm.callAllWorkers('invalidateRequireCache', [
              path.join(
                __dirname,
                '/input/node_modules/babel-plugin-dummy/index.js',
              ),
            ]);
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('replaced'), 'string should be replaced');
      });

      it('should invalidate on startup when there are relative plugins', async function() {
        let b = await testBabelCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          // cleanWorkerFarm: true,
          async setup() {
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              path.join(__dirname, '/input'),
            );
            await inputFS.copyFile(
              path.join(
                __dirname,
                '/integration/babelrc-custom/babel-plugin-dummy.js',
              ),
              path.join(__dirname, '/input/babel-plugin-dummy.js'),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelrc'),
              JSON.stringify({
                plugins: ['./babel-plugin-dummy'],
              }),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/src/index.js'),
              'console.log("REPLACE_ME")',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('hello there'),
              'string should be replaced',
            );

            let plugin = path.join(__dirname, '/input/babel-plugin-dummy.js');
            let source = await inputFS.readFile(plugin, 'utf8');
            await inputFS.writeFile(
              plugin,
              source.replace('hello there', 'replaced'),
            );

            await workerFarm.callAllWorkers('invalidateRequireCache', [
              path.join(__dirname, '/input/babel-plugin-dummy.js'),
            ]);
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('replaced'), 'string should be replaced');
      });

      it('should invalidate on startup when there are symlinked plugins', async function() {
        let b = await testBabelCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              path.join(__dirname, '/input'),
            );
            await inputFS.mkdirp(
              path.join(__dirname, '/input/packages/babel-plugin-dummy'),
            );
            await inputFS.mkdirp(path.join(__dirname, '/input/node_modules'));
            fs.symlinkSync(
              path.join(__dirname, '/input/packages/babel-plugin-dummy'),
              path.join(__dirname, '/input/node_modules/babel-plugin-dummy'),
            );
            await inputFS.writeFile(
              path.join(
                __dirname,
                '/input/packages/babel-plugin-dummy/package.json',
              ),
              JSON.stringify({
                name: 'babel-plugin-dummy',
                version: '1.0.0',
              }),
            );
            await inputFS.copyFile(
              path.join(
                __dirname,
                '/integration/babelrc-custom/babel-plugin-dummy.js',
              ),
              path.join(
                __dirname,
                '/input/packages/babel-plugin-dummy/index.js',
              ),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/.babelrc'),
              JSON.stringify({
                plugins: ['babel-plugin-dummy'],
              }),
            );
            await inputFS.writeFile(
              path.join(__dirname, '/input/src/index.js'),
              'console.log("REPLACE_ME")',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('hello there'),
              'string should be replaced',
            );

            let plugin = path.join(
              __dirname,
              '/input/packages/babel-plugin-dummy/index.js',
            );
            let source = await inputFS.readFile(plugin, 'utf8');
            await inputFS.writeFile(
              plugin,
              source.replace('hello there', 'replaced'),
            );

            await workerFarm.callAllWorkers('invalidateRequireCache', [
              path.join(
                __dirname,
                '/input/packages/babel-plugin-dummy/index.js',
              ),
            ]);
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('replaced'), 'string should be replaced');
      });
    });
  });

  describe('parcel config', function() {
    it('should support adding a .parcelrc', async function() {
      let b = await testCache(async b => {
        assert.equal(await run(b), 4);

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(!contents.includes('TRANSFORMED CODE'));

        await overlayFS.writeFile(
          path.join(__dirname, '/input/.parcelrc'),
          JSON.stringify({
            extends: '@parcel/config-default',
            transformers: {
              '*.js': ['parcel-transformer-mock'],
            },
          }),
        );
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('TRANSFORMED CODE'));
    });

    it('should support updating a .parcelrc', async function() {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(__dirname, '/input/.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('TRANSFORMED CODE'));

          await overlayFS.writeFile(
            path.join(__dirname, '/input/.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('TRANSFORMED CODE'));

      assert.equal(await run(b), 4);
    });

    it('should support updating an extended .parcelrc', async function() {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(__dirname, '/input/.parcelrc-extended'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(__dirname, '/input/.parcelrc'),
            JSON.stringify({
              extends: './.parcelrc-extended',
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('TRANSFORMED CODE'));

          await overlayFS.writeFile(
            path.join(__dirname, '/input/.parcelrc-extended'),
            JSON.stringify({
              extends: '@parcel/config-default',
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('TRANSFORMED CODE'));

      assert.equal(await run(b), 4);
    });

    it('should error when deleting an extended parcelrc', async function() {
      // $FlowFixMe
      await assert.rejects(
        async () => {
          await testCache({
            async setup() {
              await overlayFS.writeFile(
                path.join(__dirname, '/input/.parcelrc-extended'),
                JSON.stringify({
                  extends: '@parcel/config-default',
                  transformers: {
                    '*.js': ['parcel-transformer-mock'],
                  },
                }),
              );

              await overlayFS.writeFile(
                path.join(__dirname, '/input/.parcelrc'),
                JSON.stringify({
                  extends: './.parcelrc-extended',
                }),
              );
            },
            async update(b) {
              let contents = await overlayFS.readFile(
                b.getBundles()[0].filePath,
                'utf8',
              );
              assert(contents.includes('TRANSFORMED CODE'));

              await overlayFS.unlink(
                path.join(__dirname, '/input/.parcelrc-extended'),
              );
            },
          });
        },
        {message: 'Cannot find extended parcel config'},
      );
    });

    it('should support deleting a .parcelrc', async function() {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(__dirname, '/input/.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('TRANSFORMED CODE'));

          await overlayFS.unlink(path.join(__dirname, '/input/.parcelrc'));
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('TRANSFORMED CODE'));

      assert.equal(await run(b), 4);
    });
  });

  describe('transformations', function() {
    it('should invalidate when included files changes', async function() {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/test.txt'),
            'hi',
          );

          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/index.js'),
            'module.exports = require("fs").readFileSync(__dirname + "/test.txt", "utf8")',
          );
        },
        async update(b) {
          assert.equal(await run(b), 'hi');

          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/test.txt'),
            'updated',
          );
        },
      });

      assert.equal(await run(b), 'updated');
    });

    it('should invalidate when environment variables change', async function() {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(__dirname, '/input/.env'),
            'TEST=hi',
          );

          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/index.js'),
            'module.exports = process.env.TEST',
          );
        },
        async update(b) {
          assert.equal(await run(b), 'hi');

          await overlayFS.writeFile(
            path.join(__dirname, '/input/.env'),
            'TEST=updated',
          );
        },
      });

      assert.equal(await run(b), 'updated');
    });
  });

  describe('entries', function() {
    it('should support adding an entry that matches a glob', async function() {
      let b = await testCache({
        entries: ['src/entries/*.js'],
        async update(b) {
          assertBundles(b, [
            {
              name: 'a.js',
              assets: ['a.js'],
            },
            {
              name: 'b.js',
              assets: ['b.js'],
            },
          ]);

          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/entries/c.js'),
            'export let c = "c";',
          );
        },
      });

      assertBundles(b, [
        {
          name: 'a.js',
          assets: ['a.js'],
        },
        {
          name: 'b.js',
          assets: ['b.js'],
        },
        {
          name: 'c.js',
          assets: ['c.js'],
        },
      ]);
    });

    it('should support deleting an entry that matches a glob', async function() {
      let b = await testCache({
        entries: ['src/entries/*.js'],
        async update(b) {
          assertBundles(b, [
            {
              name: 'a.js',
              assets: ['a.js'],
            },
            {
              name: 'b.js',
              assets: ['b.js'],
            },
          ]);

          await overlayFS.unlink(
            path.join(__dirname, '/input/src/entries/b.js'),
          );
        },
      });

      assertBundles(b, [
        {
          name: 'a.js',
          assets: ['a.js'],
        },
      ]);
    });

    it('should error when deleting a file entry', async function() {
      // $FlowFixMe
      await assert.rejects(
        async () => {
          await testCache(async () => {
            await overlayFS.unlink(path.join(__dirname, '/input/src/index.js'));
          });
        },
        {
          message: `Entry ${path.join(
            __dirname,
            'input/src/index.js',
          )} does not exist`,
        },
      );
    });

    it('should recover from errors when adding a missing entry', async function() {
      // $FlowFixMe
      await assert.rejects(
        async () => {
          await testCache(async () => {
            await overlayFS.unlink(path.join(__dirname, '/input/src/index.js'));
          });
        },
        {
          message: `Entry ${path.join(
            __dirname,
            'input/src/index.js',
          )} does not exist`,
        },
      );

      await overlayFS.writeFile(
        path.join(__dirname, '/input/src/index.js'),
        'module.exports = "hi"',
      );

      let b = await runBundle();
      assert.equal(await run(b), 'hi');
    });
  });

  describe('target config', function() {
    it('should support adding a target config', async function() {
      let b = await testCache({
        scopeHoist: true,
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('export default'),
            'should not include export default',
          );

          let pkgFile = path.join(__dirname, '/input/package.json');
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                esmodule: {
                  outputFormat: 'esmodule',
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('export default'),
        'should include export default',
      );
    });

    it('should support adding a second target', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      let b = await testCache({
        scopeHoist: true,
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
              },
            }),
          );
        },
        async update(b) {
          assertBundles(b, [
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
          ]);

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
      });

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
      ]);
    });

    it('should support changing target output location', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      await testCache({
        scopeHoist: true,
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              modern: 'modern/index.js',
              legacy: 'legacy/index.js',
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
        async update() {
          assert(
            await overlayFS.exists(
              path.join(__dirname, '/input/modern/index.js'),
            ),
          );
          assert(
            await overlayFS.exists(
              path.join(__dirname, '/input/legacy/index.js'),
            ),
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              modern: 'dist/modern/index.js',
              legacy: 'dist/legacy/index.js',
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
      });

      assert(
        await overlayFS.exists(
          path.join(__dirname, '/input/dist/modern/index.js'),
        ),
      );
      assert(
        await overlayFS.exists(
          path.join(__dirname, '/input/dist/legacy/index.js'),
        ),
      );
    });

    it('should support updating target config options', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      let b = await testCache({
        scopeHoist: true,
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                esmodule: {
                  outputFormat: 'esmodule',
                },
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('export default'),
            'should include export default',
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                esmodule: {
                  outputFormat: 'commonjs',
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('module.exports ='),
        'should include module.exports =',
      );
    });

    it('should support deleting a target', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      let b = await testCache({
        scopeHoist: true,
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
        async update(b) {
          assertBundles(b, [
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
          ]);

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
              },
            }),
          );
        },
      });

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
      ]);
    });

    it('should support deleting all targets', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      let b = await testCache({
        scopeHoist: true,
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  outputFormat: 'esmodule',
                },
                legacy: {
                  outputFormat: 'commonjs',
                },
              },
            }),
          );
        },
        async update(b) {
          assertBundles(b, [
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
          ]);

          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('export default'),
            'should include export default',
          );

          contents = await overlayFS.readFile(
            b.getBundles()[1].filePath,
            'utf8',
          );
          assert(
            contents.includes('module.exports ='),
            'should include module.exports',
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: undefined,
            }),
          );
        },
      });

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
      ]);

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        !contents.includes('export default'),
        'should not include export default',
      );
      assert(
        !contents.includes('module.exports ='),
        'should not include module.exports',
      );
    });

    it('should update when sourcemap options change', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      let b = await testCache({
        scopeHoist: true,
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  sourceMap: true,
                },
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('sourceMappingURL=index.js.map'),
            'should include sourceMappingURL',
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  sourceMap: {
                    inline: true,
                  },
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('sourceMappingURL=data:application/json'),
        'should include inline sourceMappingURL',
      );
    });

    it('should update when publicUrl changes', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      let b = await testCache({
        entries: ['src/index.html'],
        scopeHoist: true,
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  publicUrl: 'http://example.com/',
                },
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('<script src="http://example.com'),
            'should include example.com',
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  publicUrl: 'http://mygreatwebsite.com/',
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('<script src="http://mygreatwebsite.com'),
        'should include example.com',
      );
    });

    it('should update when a package.json is created', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      let pkg;
      let b = await testCache({
        scopeHoist: true,
        async setup() {
          pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.unlink(pkgFile);
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('export default'),
            'does not include export default',
          );

          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  outputFormat: 'esmodule',
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('export default'),
        'should include export default',
      );
    });

    it('should update when a package.json is deleted', async function() {
      let pkgFile = path.join(__dirname, '/input/package.json');
      let b = await testCache({
        scopeHoist: true,
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  outputFormat: 'esmodule',
                },
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('export default'),
            'should include export default',
          );
          await overlayFS.unlink(pkgFile);
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        !contents.includes('export default'),
        'does not include export default',
      );
    });

    describe('browserslist', function() {
      it('should update when a browserslist file is added', async function() {
        let b = await testCache({
          scopeHoist: true,
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              /class \$[a-f0-9]+\$var\$Test/.test(contents),
              'should include class',
            );
            await overlayFS.writeFile(
              path.join(__dirname, '/input/browserslist'),
              'IE >= 11',
            );
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          !/class \$[a-f0-9]+\$var\$Test/.test(contents),
          'does not include class',
        );
      });

      it('should update when a .browserslistrc file is added', async function() {
        let b = await testCache({
          scopeHoist: true,
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              /class \$[a-f0-9]+\$var\$Test/.test(contents),
              'should include class',
            );
            await overlayFS.writeFile(
              path.join(__dirname, '/input/.browserslistrc'),
              'IE >= 11',
            );
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          !/class \$[a-f0-9]+\$var\$Test/.test(contents),
          'does not include class',
        );
      });

      it('should update when a browserslist is updated', async function() {
        let b = await testCache({
          scopeHoist: true,
          async setup() {
            await overlayFS.writeFile(
              path.join(__dirname, '/input/browserslist'),
              'IE >= 11',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !/class \$[a-f0-9]+\$var\$Test/.test(contents),
              'does not include class',
            );
            await overlayFS.writeFile(
              path.join(__dirname, '/input/browserslist'),
              'last 1 Chrome version',
            );
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          /class \$[a-f0-9]+\$var\$Test/.test(contents),
          'should include class',
        );
      });

      it('should update when a browserslist is deleted', async function() {
        let b = await testCache({
          scopeHoist: true,
          async setup() {
            await overlayFS.writeFile(
              path.join(__dirname, '/input/browserslist'),
              'IE >= 11',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !/class \$[a-f0-9]+\$var\$Test/.test(contents),
              'does not include class',
            );
            await overlayFS.unlink(path.join(__dirname, '/input/browserslist'));
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          /class \$[a-f0-9]+\$var\$Test/.test(contents),
          'should include class',
        );
      });

      it('should update when BROWSERSLIST_ENV changes', async function() {
        let b = await testCache({
          scopeHoist: true,
          async setup() {
            await overlayFS.writeFile(
              path.join(__dirname, '/input/browserslist'),
              `
            [production]
            IE >= 11

            [development]
            last 1 Chrome version
            `,
            );
          },
          async update(b) {
            // "production" is the default environment for browserslist
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !/class \$[a-f0-9]+\$var\$Test/.test(contents),
              'does not include class',
            );

            process.env.BROWSERSLIST_ENV = 'development';
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          /class \$[a-f0-9]+\$var\$Test/.test(contents),
          'should include class',
        );

        delete process.env.BROWSERSLIST_ENV;
      });

      it('should update when NODE_ENV changes', async function() {
        let env = process.env.NODE_ENV;
        let b = await testCache({
          scopeHoist: true,
          async setup() {
            await overlayFS.writeFile(
              path.join(__dirname, '/input/browserslist'),
              `
            [production]
            IE >= 11

            [development]
            last 1 Chrome version
            `,
            );
          },
          async update(b) {
            // "production" is the default environment for browserslist
            let contents = await overlayFS.readFile(
              b.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !/class \$[a-f0-9]+\$var\$Test/.test(contents),
              'does not include class',
            );

            process.env.NODE_ENV = 'development';
          },
        });

        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          /class \$[a-f0-9]+\$var\$Test/.test(contents),
          'should include class',
        );

        process.env.NODE_ENV = env;
      });
    });
  });

  describe('options', function() {
    it('should update when publicUrl changes', async function() {
      let b = await testCache({
        entries: ['src/index.html'],
        scopeHoist: true,
        publicUrl: 'http://example.com/',
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('<script src="http://example.com'),
            'should include example.com',
          );

          return {
            publicUrl: 'http://mygreatwebsite.com/',
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('<script src="http://mygreatwebsite.com'),
        'should include example.com',
      );
    });

    it('should update when minify changes', async function() {
      let b = await testCache({
        scopeHoist: true,
        minify: false,
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('Test'), 'should include Test');

          return {
            minify: true,
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('Test'), 'should not include Test');
    });

    it('should update when scopeHoist changes', async function() {
      let b = await testCache({
        scopeHoist: false,
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('parcelRequire'),
            'should include parcelRequire',
          );

          return {
            scopeHoist: true,
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('parcelRequire'), 'should not include Test');
    });

    it('should update when sourceMaps changes', async function() {
      let b = await testCache({
        sourceMaps: false,
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('sourceMappingURL=index.js.map'),
            'should not include sourceMappingURL',
          );

          return {
            sourceMaps: true,
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('sourceMappingURL=index.js.map'),
        'should include sourceMappingURL',
      );
    });

    it('should update when distDir changes', async function() {
      let b = await testCache({
        scopeHoist: true,
        update(b) {
          assert(
            /dist[/\\]index.js$/.test(b.getBundles()[0].filePath),
            'should end with dist/index.js',
          );

          return {
            distDir: 'dist/test',
          };
        },
      });

      assert(
        /dist[/\\]test[/\\]index.js$/.test(b.getBundles()[0].filePath),
        'should end with dist/test/index.js',
      );
    });

    it('should update when targets changes', async function() {
      let b = await testCache({
        scopeHoist: true,
        targets: ['legacy'],
        async setup() {
          let pkgFile = path.join(__dirname, '/input/package.json');
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
        async update(b) {
          assertBundles(b, [
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
          ]);

          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !/class \$[a-f0-9]+\$var\$Test/.test(contents),
            'should not include class',
          );

          return {
            targets: ['modern'],
          };
        },
      });

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
      ]);

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        /class \$[a-f0-9]+\$var\$Test/.test(contents),
        'should include class',
      );
    });

    it('should update when defaultEngines changes', async function() {
      let b = await testCache({
        scopeHoist: true,
        defaultEngines: {
          browsers: 'last 1 Chrome version',
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            /class \$[a-f0-9]+\$var\$Test/.test(contents),
            'should include class',
          );

          return {
            defaultEngines: {
              browsers: 'IE 11',
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        !/class \$[a-f0-9]+\$var\$Test/.test(contents),
        'should not include class',
      );
    });

    it('should update when contentHash changes', async function() {
      let b = await testCache({
        entries: ['src/index.html'],
        scopeHoist: true,
        contentHash: true,
        update(b) {
          let bundle = b.getBundles()[1];
          assert(!bundle.name.includes(bundle.id.slice(-8)));

          return {
            contentHash: false,
          };
        },
      });

      let bundle = b.getBundles()[1];
      assert(bundle.name.includes(bundle.id.slice(-8)));
    });

    it('should update when hot options change', async function() {
      let b = await testCache({
        hot: {
          host: 'localhost',
          port: 4321,
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('HMR_HOST = "localhost"'),
            'should include HMR_HOST = "localhost"',
          );
          assert(
            contents.includes('HMR_PORT = 4321'),
            'should include HMR_PORT = 4321',
          );

          return {
            hot: {
              host: 'example.com',
              port: 5678,
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('HMR_HOST = "example.com"'),
        'should include HMR_HOST = "example.com"',
      );
      assert(
        contents.includes('HMR_PORT = 5678'),
        'should include HMR_PORT = 5678',
      );
    });

    it('should invalidate react refresh hot options change', async function() {
      let b = await testCache({
        async setup() {
          let pkgFile = path.join(__dirname, '/input/package.json');
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              dependencies: {
                react: '*',
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/index.js'),
            `import React from 'react';
            
            export function Component() {
              return <h1>Hello world</h1>;
            }`,
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('getRefreshBoundarySignature'),
            'should not include getRefreshBoundarySignature',
          );

          return {
            hot: {
              host: 'example.com',
              port: 5678,
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('getRefreshBoundarySignature'),
        'should include getRefreshBoundarySignature',
      );
    });

    it('should update when the config option changes', async function() {
      let b = await testCache({
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(!contents.includes('TRANSFORMED CODE'));

          await overlayFS.writeFile(
            path.join(__dirname, '/input/some-config'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );

          return {
            config: path.join(__dirname, '/input/some-config'),
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('TRANSFORMED CODE'));
    });

    it('should update when the defaultConfig option changes', async function() {
      let b = await testCache({
        async update(b) {
          let contents = await overlayFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );
          assert(!contents.includes('TRANSFORMED CODE'));

          await overlayFS.writeFile(
            path.join(__dirname, '/input/some-config'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );

          return {
            defaultConfig: path.join(__dirname, '/input/some-config'),
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('TRANSFORMED CODE'));
    });
  });

  describe.only('resolver', function() {
    it('should support updating a package.json#main field', async function() {
      let b = await testCache(async b => {
        assert.equal(await run(b), 4);
        await overlayFS.writeFile(
          path.join(__dirname, '/input/node_modules/foo/test.js'),
          'module.exports = 4;',
        );

        await overlayFS.writeFile(
          path.join(__dirname, '/input/node_modules/foo/package.json'),
          JSON.stringify({main: 'test.js'})
        );
      });

      assert.equal(await run(b), 8);
    });

    it('should support adding an alias', async function() {
      let b = await testCache(async b => {
        assert.equal(await run(b), 4);
        await overlayFS.writeFile(
          path.join(__dirname, '/input/node_modules/foo/test.js'),
          'module.exports = 4;',
        );

        await overlayFS.writeFile(
          path.join(__dirname, '/input/node_modules/foo/package.json'),
          JSON.stringify({
            main: 'foo.js',
            alias: {
              './foo.js': './test.js'
            }
          })
        );
      });

      assert.equal(await run(b), 8);
    });

    it('should support updating an alias', async function() {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(__dirname, '/input/node_modules/foo/test.js'),
            'module.exports = 4;',
          );

          await overlayFS.writeFile(
            path.join(__dirname, '/input/node_modules/foo/package.json'),
            JSON.stringify({
              main: 'foo.js',
              alias: {
                './foo.js': './test.js'
              }
            })
          );
        },
        async update(b) {
          assert.equal(await run(b), 8);
          await overlayFS.writeFile(
            path.join(__dirname, '/input/node_modules/foo/baz.js'),
            'module.exports = 6;',
          );

          await overlayFS.writeFile(
            path.join(__dirname, '/input/node_modules/foo/package.json'),
            JSON.stringify({
              main: 'foo.js',
              alias: {
                './foo.js': './baz.js'
              }
            })
          );
        }
      });

      assert.equal(await run(b), 12);
    });

    it('should support deleting an alias', async function() {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(__dirname, '/input/node_modules/foo/test.js'),
            'module.exports = 4;',
          );

          await overlayFS.writeFile(
            path.join(__dirname, '/input/node_modules/foo/package.json'),
            JSON.stringify({
              main: 'foo.js',
              alias: {
                './foo.js': './test.js'
              }
            })
          );
        },
        async update(b) {
          assert.equal(await run(b), 8);
          await overlayFS.writeFile(
            path.join(__dirname, '/input/node_modules/foo/package.json'),
            JSON.stringify({main: 'foo.js'})
          );
        }
      });

      assert.equal(await run(b), 4);
    });

    it('should support adding a file with a higher priority extension', async function() {
      let b = await testCache({
        async setup() {
          // Start out pointing to a .ts file from a .js file
          let contents = await overlayFS.readFile(
            path.join(__dirname, '/input/src/index.js'),
            'utf8'
          );
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/index.js'),
            contents.replace('nested/test', 'nested/foo'),
          );
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested/foo.ts'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b), 6);

          // Adding a .js file should be higher priority
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested/foo.js'),
            'module.exports = 2;',
          );
        }
      });

      assert.equal(await run(b), 4);
    });

    it('should support renaming a file to a different extension', async function() {
      let b = await testCache({
        async setup() {
          // Start out pointing to a .js file
          let contents = await overlayFS.readFile(
            path.join(__dirname, '/input/src/index.js'),
            'utf8'
          );
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/index.js'),
            contents.replace('nested/test', 'nested/foo'),
          );
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested/foo.js'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b), 6);

          // Rename to .ts
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested/foo.ts'),
            'module.exports = 2;',
          );

          await overlayFS.unlink(
            path.join(__dirname, '/input/src/nested/foo.js'),
          );
        }
      });

      assert.equal(await run(b), 4);
    });

    it('should resolve to a file over a directory with an index.js', async function() {
      let b = await testCache({
        async setup() {
          let contents = await overlayFS.readFile(
            path.join(__dirname, '/input/src/index.js'),
            'utf8'
          );
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/index.js'),
            contents.replace('nested/test', 'nested'),
          );
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested/index.js'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b), 6);

          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested.js'),
            'module.exports = 2;',
          );
        }
      });

      assert.equal(await run(b), 4);
    });

    it('should resolve to package.json#main over an index.js', async function() {
      let b = await testCache({
        async setup() {
          let contents = await overlayFS.readFile(
            path.join(__dirname, '/input/src/index.js'),
            'utf8'
          );
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/index.js'),
            contents.replace('nested/test', 'nested'),
          );
          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested/index.js'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b), 6);

          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested/package.json'),
            JSON.stringify({
              main: 'test.js'
            })
          );
        }
      });

      assert.equal(await run(b), 4);
    });

    it('should recover from errors when adding a missing dependency', async function() {
      // $FlowFixMe
      await assert.rejects(
        async () => {
          await testCache({
            async setup() {
              await overlayFS.unlink(path.join(__dirname, '/input/src/nested/test.js'));
            },
            async update() {}
          });
        },
        {
          message: "Failed to resolve './nested/test' from './src/index.js'",
        },
      );

      await overlayFS.writeFile(
        path.join(__dirname, '/input/src/nested/test.js'),
        'module.exports = 4;',
      );

      let b = await runBundle();
      assert.equal(await run(b), 6);
    });

    it.only('should support adding a deeper node_modules folder', async function() {
      let b = await testCache({
        async update(b) {
          assert.equal(await run(b), 4);

          await overlayFS.mkdirp(
             path.join(__dirname, '/input/src/nested/node_modules/foo'),
          );

          await overlayFS.writeFile(
            path.join(__dirname, '/input/src/nested/node_modules/foo/index.js'),
            'module.exports = 4;'
          );
        }
      });

      assert.equal(await run(b), 6);
    });

    it('should support updating a symlink', function() {});
  });

  describe('bundler config', function() {
    it('should support adding bundler config', function() {});

    it('should support updating bundler config', function() {});

    it('should support removing bundler config', function() {});
  });

  describe('scope hoisting', function() {
    it('should support adding sideEffects config', function() {});

    it('should support updating sideEffects config', function() {});

    it('should support removing sideEffects config', function() {});
  });

  describe('runtime', () => {
    it('should support updating files added by runtimes', async function() {
      let b = await testCache(async b => {
        let contents = await overlayFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('INITIAL CODE'));
        await overlayFS.writeFile(
          path.join(__dirname, 'input/dynamic-runtime.js'),
          "module.exports = 'UPDATED CODE'",
        );
      }, 'runtime-update');

      let contents = await overlayFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('UPDATED CODE'));
    });
  });
});
