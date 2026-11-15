# Third-party notices

The [mailFastApi Noncommercial License 1.0](LICENSE) applies to the project's
own code and documentation. Third-party dependencies retain their own licenses;
the project's noncommercial restrictions do not override their grants.

Direct npm dependencies in the current lockfile:

| Dependency | Locked version | License | Upstream |
| --- | --- | --- | --- |
| dotenv | 16.6.1 | BSD-2-Clause | [motdotla/dotenv](https://github.com/motdotla/dotenv) |
| Express | 4.22.2 | MIT | [expressjs/express](https://github.com/expressjs/express) |
| jsonwebtoken | 9.0.3 | MIT | [auth0/node-jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) |
| Nodemailer | 8.0.5 | MIT-0 | [nodemailer/nodemailer](https://github.com/nodemailer/nodemailer) |
| node-redis | 4.7.1 | MIT | [redis/node-redis](https://github.com/redis/node-redis) |

The complete dependency graph and package license metadata are recorded in
[package-lock.json](package-lock.json). After `npm ci`, the full license texts
and copyright notices are available in the corresponding `node_modules/`
packages. Preserve all required notices, including those of transitive
dependencies, when redistributing installed dependencies or bundled builds.

The `redis` npm package above is the JavaScript client. A separately installed
Redis server has its own version-dependent license. Node.js, system libraries,
SMTP providers, and other separately installed services are not relicensed by
this project. The source repository does not vendor those runtimes or services.

For the transition from the project's earlier GPL copies, see
[docs/LICENSING.md](docs/LICENSING.md#earlier-gpl-versions).
