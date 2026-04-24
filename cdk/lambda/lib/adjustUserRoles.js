const { initializeConnection } = require("./lib.js");
const { CognitoIdentityProviderClient, AdminListGroupsForUserCommand, AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection = global.sqlConnection;

// OPT-11: Client at module level, AdminGetUserCommand removed (email from event)
const client = new CognitoIdentityProviderClient();

exports.handler = async (event) => {
  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  const { userName, userPoolId } = event;
  const email = event.request.userAttributes.email;

  try {
    // Get user groups from Cognito
    const userGroupsCommand = new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: userName,
    });
    const userGroupsResponse = await client.send(userGroupsCommand);
    const cognitoRoles = userGroupsResponse.Groups.map(group => group.GroupName);

    // Retrieve roles from the database
    const dbUser = await sqlConnection`
      SELECT roles FROM "Users"
      WHERE user_email = ${email};
    `;
    
    const dbRoles = dbUser[0]?.roles || [];

    // Handle role synchronization between Cognito and DB
    if (cognitoRoles.includes('admin')) {
      // If Cognito has admin, make sure DB is also admin
      if (!dbRoles.includes('admin')) {
        await sqlConnection`
          UPDATE "Users"
          SET roles = array_append(roles, 'admin')
          WHERE user_email = ${email};
        `;
        console.log('DB roles updated to include admin');
      }
    } else if (cognitoRoles.some(role => ['instructor', 'student'].includes(role))) {
      const cognitoNonAdminRole = cognitoRoles.find(role => ['instructor', 'student'].includes(role));
      
      if (dbRoles.includes('admin')) {
        // If DB has admin but Cognito is not admin, update DB role to match Cognito
        await sqlConnection`
          UPDATE "Users"
          SET roles = ${[cognitoNonAdminRole]}
          WHERE user_email = ${email};
        `;
        console.log(`DB roles updated to match Cognito (${cognitoNonAdminRole})`);
      } else if (dbRoles.length && dbRoles[0] !== cognitoNonAdminRole) {
        // If DB role doesn't match Cognito and isn't admin, update Cognito to match DB
        const removeFromGroupCommand = new AdminRemoveUserFromGroupCommand({
          UserPoolId: userPoolId,
          Username: userName,
          GroupName: cognitoNonAdminRole,
        });
        const addToGroupCommand = new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: userName,
          GroupName: dbRoles[0],
        });

        await client.send(removeFromGroupCommand);
        await client.send(addToGroupCommand);

        console.log(`Cognito roles updated to match DB (${dbRoles[0]})`);
      }
    }

    return event;
  } catch (err) {
    console.error(err);
    return event;
  }
};
