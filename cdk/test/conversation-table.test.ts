import { Template } from 'aws-cdk-lib/assertions';
import { createTestStacks } from './helpers/stack-setup';

/**
 * DynamoDB-Conversation-Table (chat history for chatbotV2 + DeleteLastMessage).
 *
 * The table was created at runtime by the removed V1 text_generation Lambda, so
 * existing environments bring it under CloudFormation with `cdk import`
 * (docs/guides/conversation-table-import.md). Import only works if the template
 * matches the live table and the resource is retained, so these properties are
 * load-bearing: changing them requires a migration, not a template edit.
 */

let apiTemplate: Template;

beforeAll(() => {
  apiTemplate = createTestStacks().apiTemplate;
});

describe('Conversation table', () => {
  test('matches the live table definition used for import', () => {
    const tables = apiTemplate.findResources('AWS::DynamoDB::Table', {
      Properties: { TableName: 'DynamoDB-Conversation-Table' },
    });
    expect(Object.keys(tables)).toEqual(['ConversationTable']);

    const props = tables.ConversationTable.Properties;
    expect(props.KeySchema).toEqual([{ AttributeName: 'SessionId', KeyType: 'HASH' }]);
    expect(props.AttributeDefinitions).toEqual([{ AttributeName: 'SessionId', AttributeType: 'S' }]);
    expect(props.BillingMode).toBe('PAY_PER_REQUEST');
    // Live table: AWS-owned encryption, no streams, PITR, TTL or indexes.
    for (const absent of [
      'SSESpecification',
      'StreamSpecification',
      'PointInTimeRecoverySpecification',
      'TimeToLiveSpecification',
      'GlobalSecondaryIndexes',
      'LocalSecondaryIndexes',
      'ProvisionedThroughput',
    ]) {
      expect(props[absent]).toBeUndefined();
    }
  });

  test('is retained on delete and replace, so chat history can never be dropped by a deploy', () => {
    const table = apiTemplate.findResources('AWS::DynamoDB::Table', {
      Properties: { TableName: 'DynamoDB-Conversation-Table' },
    }).ConversationTable;
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.UpdateReplacePolicy).toBe('Retain');
  });

  test('import mapping file targets the ConversationTable logical ID', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mapping = require('../import/conversation-table-mapping.json');
    expect(mapping).toEqual({ ConversationTable: { TableName: 'DynamoDB-Conversation-Table' } });
  });
});
