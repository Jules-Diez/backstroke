import repl from 'repl';
import debug from 'debug';
import uuid from 'uuid';
import fetch from 'node-fetch';

import RedisMQ from 'rsmq';
const redis = new RedisMQ({
  client: require('redis').createClient(process.env.REDIS_URL),
  ns: 'rsmq',
});

export const WebhookQueue = {
  queueName: process.env.REDIS_QUEUE_NAME || 'webhookQueue',
  initialize() {
    return new Promise((resolve, reject) => {
      redis.createQueue({qname: this.queueName}, (err, resp) => {
        if (err && err.name === 'queueExists') {
          // Queue was already created.
          resolve();
        } else if (err) {
          reject(err);
        } else {
          resolve(resp);
        }
      });
    });
  },
  push(data) {
    return new Promise((resolve, reject) => {
      redis.sendMessage({qname: this.queueName, message: JSON.stringify(data)}, (err, id) => {
        if (err) {
          reject(err);
        } else {
          // Resolves the message id.
          resolve(id);
        }
      });
    });
  },
  pop() {
    return new Promise((resolve, reject) => {
      redis.popMessage({qname: this.queueName}, (err, {message, id}) => {
        if (err) {
          reject(err);
        } else if (typeof id === 'undefined') {
          // No items in the queue
          resolve(null);
        } else {
          // Item was found on the end of the queue!
          resolve(message);
        }
      });
    });
  }
};
WebhookQueue.initialize();




import Sequelize from 'sequelize';
const schema = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: true
  }
});




export const User = schema.define('user', {
  id: {
    type: Sequelize.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  username: {
    type: Sequelize.STRING,
    unique: true,
  },
  email: {
    type: Sequelize.STRING,
    allowNull: true,
  },
  githubId: {
    type: Sequelize.STRING,
    allowNull: false,
    unique: true,
  },
  accessToken: {
    type: Sequelize.STRING,
    allowNull: false,
  },

  // Did the user register with the `public` scope (only providing access to open source repos)?
  publicScope: { type: Sequelize.BOOLEAN },

  createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW},
  lastLoggedInAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW},
});

// Create a new user in the registration function
User.register = async function register(profile, accessToken) {
  const logger = debug('backstroke:user:register');

  // Does the user already exist?
  const model = await User.findOne({where: {githubId: profile.id.toString()}});

  // What permissions was the given token given?
  let permissions = [];
  const scopes = (await fetch('https://api.github.com/users/backstroke-bot', {
    headers: {
      'Authorization': `token ${accessToken}`,
    },
  })).headers.get('x-oauth-scopes');
  if (scopes && scopes.length > 0) {
    permissions = scopes.split(',').map(i => i.trim());
  }

  // Did the user only give us access to public repos?
  const publicScope = permissions.indexOf('public_repo') >= 0;

  // If so, then just update the user model with the new info.
  if (model) {
    logger(
      'UPDATING USER MODEL %o WITH %o, username = %o, email = %o, publicScope = %o',
      model,
      profile.id,
      profile.username,
      profile.email,
      publicScope,
    );

    const [updatedId] = await User.update({
      username: profile.username,
      email: profile._json.email,
      githubId: profile.id,
      accessToken,
      publicScope,

      lastLoggedInAt: new Date,
    }, {where: {id: model.id}});

    return User.findById(updatedId);
  } else {
    logger('CREATE USER %o', profile.username);
    return User.create({
      username: profile.username,
      email: profile._json.email,
      githubId: profile.id,
      accessToken,
      publicScope,

      lastLoggedInAt: new Date,
    });
  }
}





export const Link = schema.define('link', {
  name: {
    type: Sequelize.STRING,
    allowNull: false,
  },
  enabled: {
    type: Sequelize.BOOLEAN,
    allowNull: false,
  },

  webhookId: { type: Sequelize.STRING, defaultValue: () => uuid.v4().replace(/-/g, '') },

  upstreamType: {type: Sequelize.ENUM, values: ['repo']},
  upstreamOwner: Sequelize.STRING,
  upstreamRepo: Sequelize.STRING,
  upstreamIsFork: Sequelize.BOOLEAN,
  upstreamBranches: Sequelize.STRING,
  upstreamBranch: Sequelize.STRING,

  forkType: {type: Sequelize.ENUM, values: ['repo', 'fork-all']},
  forkOwner: Sequelize.STRING,
  forkRepo: Sequelize.STRING,
  forkBranches: Sequelize.STRING,
  forkBranch: Sequelize.STRING,
});

// A link has a foreign key to a user.
Link.belongsTo(User, {as: 'owner', foreignKey: 'ownerId'});

// Convert a link to its owtward-facing structure. Expand all foreign keys and
// remove sensitive data.
Link.prototype.display = function display() {
  return {
    id: this.id,
    name: this.name,
    enabled: this.enabled,
    webhook: this.webhookId,

    fork: this.fork(),
    upstream: this.upstream(),
  };
}

Link.prototype.fork = function fork() {
  if (this.forkType === 'fork-all') {
    return {type: 'fork-all'};
  } else {
    return {
      type: this.forkType,
      owner: this.forkOwner,
      repo: this.forkRepo,
      isFork: true,
      branches: JSON.parse(this.forkBranches),
      branch: this.forkBranch,
    };
  }
}

Link.prototype.upstream = function upstream() {
  return {
    type: this.upstreamType,
    owner: this.upstreamOwner,
    repo: this.upstreamRepo,
    isFork: this.upstreamFork,
    branches: JSON.parse(this.upstreamBranches),
    branch: this.upstreamBranch,
  };
}

if (require.main === module) {
  if (process.argv[2] === 'migrate') {
    console.log('Migrating schema...');
    Link.sync({alter: true});
    User.sync({alter: true});
    console.log('Done.');
  } else if (process.argv[2] === 'shell') {
    const options = {
      useColors: true,
      useGlobal: true,
    };
    const context = {
      redis,
      schema,
      Link,
      User,
      WebhookQueue,
    };

    // From https://stackoverflow.com/questions/33673999/passing-context-to-interactive-node-shell-leads-to-typeerror-sandbox-argument
    Object.assign(repl.start(options).context, context);
  }
}
