import express from 'express';
const app = express();

import cors from 'cors';
const corsHandler = cors({
  origin(origin, callback) {
    if (!origin || origin.match(new RegExp(process.argv.CORS_ORIGIN_REGEXP, 'i'))) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
});
app.use(corsHandler);
app.options('*', corsHandler);

// Polyfill promise with bluebird.
import Promise from 'bluebird';
global.Promise = Promise;

// How should we redirect to other origins? If unset, add some mocks to this app to use as those
// redirects.
const APP_URL = process.env.APP_URL || '/mocks/app';
if (APP_URL === '/mocks/app') {
  app.get('/mocks/app', (req, res) => res.send('This would redirect to the app when deployed.'));
}
const ROOT_URL = process.env.ROOT_URL || '/mocks/root';
if (APP_URL === '/mocks/root') {
  app.get('/mocks/root', (req, res) => res.send('This would redirect to the main site when deployed.'));
}
app.get('/', (req, res) => {
  if (req.user) {
    res.send(`${req.user.username} logged in.`);
  } else {
    res.send(`
    <a href="/setup/login">Login private</a>
    <a href="/setup/login/public">Login public</a>
    `);
  }
});

// ----------------------------------------------------------------------------
// Routes and helpers for the routes
// ----------------------------------------------------------------------------
import route from './helpers/route';

import whoami from './routes/whoami';
import checkRepo from './routes/checkRepo';

import webhook from './routes/webhook';

import linksList from './routes/links/list';
import linksGet from './routes/links/get';
import linksCreate from './routes/links/create';
import linksDelete from './routes/links/delete';
import linksUpdate from './routes/links/update';
import linksEnable from './routes/links/enable';

import { Link, User, Repository, WebhookQueue } from './models';

/* app.use((err, req, res, next) => { */
/*   if (err.name === 'ValidationError') { */
/*     res.status(err.statusCode).send({ */
/*       ok: false, */
/*       error: 'validation', */
/*       context: err.context, */
/*       issues: err.codes, */
/*     }); */
/*   } else { */
/*     console.error(err.stack); */
/*     res.status(500).send(err.stack); */
/*   }; */
/* }) */

// Use sentry in production
import Raven from 'raven';
if (process.env.SENTRY_CONFIG) {
  Raven.config(process.env.SENTRY_CONFIG).install();
}

// ----------------------------------------------------------------------------
// Passport stuff
// ----------------------------------------------------------------------------
import passport from 'passport';
import session from 'express-session';
import fileStore from 'session-file-store';
const FileStore = fileStore(session);
import strategy from './auth/strategy';
import serialize from './auth/serialize';
app.use(session({
  secret: process.env.SESSION_SECRET,
  store: new FileStore({
    path: "/tmp/sessions/",
    useAsync: true,
    reapInterval: 5000,
    maxAge: 10000
  }),
  saveUninitialized: true,
  resave: true,
}));
app.use(passport.initialize());
app.use(passport.session());
passport.use(strategy(User));
serialize(User, passport);

import bodyParser from 'body-parser';
import morgan from 'morgan';
app.use(morgan('tiny'));

// Authenticate a user
app.get('/setup/login', passport.authenticate('github', {
  successRedirect: '/',
  scope: ["repo", "write:repo_hook", "user:email"],
}));
app.get('/setup/login/public', passport.authenticate('github', {
  successRedirect: '/',
  scope: ["public_repo", "write:repo_hook", "user:email"],
}));

// Second leg of the auth
app.get("/auth/github/callback", passport.authenticate("github", {
  failureRedirect: '/setup/failed',
}), (req, res) => {
  res.redirect(APP_URL); // on success
});

// Second leg of the auth
app.get("/auth/github-public/callback", passport.authenticate("github-public", {
  failureRedirect: '/setup/failed',
}), (req, res) => {
  res.redirect(APP_URL); // on success
});

app.get('/logout', (req, res) => {
  req.logout();
  res.redirect(ROOT_URL);
});

// A utility function to check if a user is authenticated, and if so, return
// the authenticated user. Otherwise, this function will throw an error
function assertLoggedIn(req, res, next) {
  if (req.isAuthenticated()) {
    next();
  } else {
    res.status(401).send({error: 'Not authenticated.'});
  }
}

import GitHubApi from 'github';
function constructor(github) {
  return {
    reposGet: Promise.promisify(github.repos.get),
    reposGetBranch: Promise.promisify(github.repos.getBranch),
    reposGetBranches: Promise.promisify(github.repos.getBranches),
    reposGetForks: Promise.promisify(github.repos.getForks),
    reposFork: Promise.promisify(github.repos.fork),
    reposEdit: Promise.promisify(github.repos.edit),
    reposDelete: Promise.promisify(github.repos['delete']),
    reposMerge: Promise.promisify(github.repos.merge),
    reposAddCollaborator: Promise.promisify(github.repos.addCollaborator),

    pullRequestsCreate: Promise.promisify(github.pullRequests.create),
    pullRequestsGetAll: Promise.promisify(github.pullRequests.getAll),
    pullRequestsMerge: Promise.promisify(github.pullRequests.merge),

    reposCreateHook: Promise.promisify(github.repos.createHook),
    reposDeleteHook: Promise.promisify(github.repos.deleteHook),
    reposFork: Promise.promisify(github.repos.fork),
    reposGetCollaborators: Promise.promisify(github.repos.getCollaborators),
    searchIssues: Promise.promisify(github.search.issues),
  };
}

// Authorize the bot.
const bot = new GitHubApi({});
bot.authenticate({
  type: "oauth",
  token: process.env.GITHUB_TOKEN,
});

// An express middleware that adds a github api instance to the request for the currently
// authenticated user. If no user is logged in, the property isn't set.
function authedGithubInstance(req, res, next) {
  req.github = {};

  // Add the bot api instance to the request.
  req.github.bot = constructor(bot);

  // If a user is logged in, create an add a user instance.
  if (req.user) {
    const github = new GitHubApi({});
    github.authenticate({
      type: "oauth",
      token: req.user.accessToken,
    });
    
    req.github.user = constructor(github);
  }
  return next();
}

// Redirect calls to `/api/v1` => `/v1`
app.all(/^\/api\/v1\/.*$/, (req, res) => res.redirect(req.url.replace(/^\/api/, '')));

// Identify the currently logged in user
app.get('/v1/whoami', whoami);

// GET all links
app.get('/v1/links', bodyParser.json(), assertLoggedIn, route(linksList, [Link]));

// GET a given link
app.get('/v1/links/:id', bodyParser.json(), assertLoggedIn, route(linksGet, [Link]));

// Create a new link
app.post('/v1/links', bodyParser.json(), assertLoggedIn, route(linksCreate, [Link]));

// delete a link
app.delete('/v1/links/:id', assertLoggedIn, route(linksDelete, [Link]));

// return the branches for a given repo
app.get('/v1/repos/:provider/:user/:repo', bodyParser.json(), assertLoggedIn, authedGithubInstance, checkRepo);

// POST link updates
app.post('/v1/links/:linkId', bodyParser.json(), assertLoggedIn, route(linksUpdate, [Link]));

// enable or disable a repository
app.post('/v1/links/:linkId/enable', bodyParser.json(), route(linksEnable, [Link]));

// the new webhook route
app.all('/_:linkId', route(webhook, [Link, User, WebhookQueue]));

if (require.main === module) {
  const port = process.env.PORT || 8001;
  app.listen(port);
  console.log('Listening on port', port);
}
