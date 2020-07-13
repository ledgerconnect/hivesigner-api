import { Router } from 'express';
import { authenticate, verifyPermissions } from '../helpers/middleware';
import { getErrorMessage, isOperationAuthor } from '../helpers/utils';
import { issue } from '../helpers/token';
import client from '../helpers/client';
import hivejs from '../helpers/hive';
import { authorized_operations, token_expiration } from '../config.json';

const router = Router();

/** Get my account details */
router.all('/me', authenticate(), async (req, res) => {
  const scope = req.scope.length ? req.scope : authorized_operations;
  let accounts;
  try {
    accounts = await client.database.getAccounts([req.user]);
  } catch (err) {
    console.error(`Get account @${req.user} failed`, err);
    return res.status(501).json({
      error: 'server_error',
      error_description: 'Request to hived API failed',
    });
  }

  let metadata;
  if (accounts[0] && accounts[0].posting_json_metadata) {
    try {
      metadata = JSON.parse(accounts[0].posting_json_metadata);
      if (!metadata.profile || !metadata.profile.version) {
        metadata = {};
      }
    } catch(e) {
      console.error(`Error parsing account posting_json ${req.user}`, e); // error in parsing
      metadata = {};
    }
  }
  // otherwise, fall back to reading from `json_metadata`
  if (accounts[0] && accounts[0].json_metadata && (!metadata || !metadata.profile)) {
    try {
      metadata = JSON.parse(accounts[0].json_metadata)
    } catch (error) {
      console.error(`Error parsing account json ${req.user}`, error); // error in parsing
      metadata = {}
    }
  }

  return res.json({
    user: req.user,
    _id: req.user,
    name: req.user,
    account: accounts[0],
    scope,
    user_metadata: metadata,
  });
});

/** Broadcast transaction */
router.post('/broadcast', authenticate('app'), verifyPermissions, async (req, res) => {
  const scope = req.scope.length ? req.scope : authorized_operations;
  const { operations } = req.body;

  let scopeIsValid = true;
  let requestIsValid = true;
  let invalidScopes = '';
  operations.forEach((operation) => {
    /** Check if operation is allowed */
    if (scope.indexOf(operation[0]) === -1) {
      scopeIsValid = false;
      invalidScopes += (invalidScopes !== '' ? ', ' : '') + operation[0];
    }
    /** Check if author of the operation is user */
    if (!isOperationAuthor(operation[0], operation[1], req.user)) {
      requestIsValid = false;
    }
    if (
      operation[0] === 'account_update2'
      && (operation[1].owner || operation[1].active || operation[1].posting)
    ) {
      requestIsValid = false;
    }
  });

  if (!scopeIsValid) {
    res.status(401).json({
      error: 'invalid_scope',
      error_description: `The access_token scope does not allow the following operation(s): ${invalidScopes}`,
    });
  } else if (!requestIsValid) {
    res.status(401).json({
      error: 'unauthorized_client',
      error_description: `This access_token allow you to broadcast transaction only for the account @${req.user}`,
    });
  } else {
    hivejs.broadcast.send(
      { operations, extensions: [] },
      { posting: process.env.BROADCASTER_POSTING_WIF },
      (err, result) => {
        if (!err) {
          console.log(new Date().toISOString(), `Broadcasted: success for @${req.user} from app @${req.proxy}`);
          res.json({ result });
        } else {
          console.log(
            new Date().toISOString(),
            `Broadcasted: failed for @${req.user} from app @${req.proxy}`,
            JSON.stringify(req.body),
            JSON.stringify(err),
          );
          res.status(500).json({
            error: 'server_error',
            error_description: getErrorMessage(err) || err.message || err,
            response: err,
          });
        }
      },
    );
  }
});

/** Request app access token */
router.all('/oauth2/token', authenticate(['code', 'refresh']), async (req, res) => {
  console.log(new Date().toISOString(), `Issue tokens for user @${req.user} for @${req.proxy} app.`);
  res.json({
    access_token: issue(req.proxy, req.user, 'posting'),
    refresh_token: issue(req.proxy, req.user, 'refresh'),
    expires_in: token_expiration,
    username: req.user,
  });
});

/** Revoke access token */
router.all('/oauth2/token/revoke', authenticate('app'), async (req, res) => {
  res.json({ success: true });
});

export default router;
