export const validRecipeV1Fixture = {
  baseRequirements: {
    baseType: 'Large Cluster Jewel',
    itemClass: 'Jewel',
    minItemLevel: 84,
    tradeQuery: {
      provider: 'poe-trade',
      query: {
        query: {
          filters: {
            misc_filters: {
              filters: { ilvl: { min: 84 } },
            },
          },
          type: 'Large Cluster Jewel',
        },
        sort: { price: 'asc' },
      },
      schemaVersion: 1,
    },
  },
  category: 'cluster-jewel',
  craftSteps: [
    {
      id: 'harvest-reforge',
      metadata: {
        method: 'harvest',
        notes: ['Repeat until all target modifiers are present'],
      },
      title: 'Reforge with Physical',
    },
  ],
  estimator: { n: 10, strategy: 'median_top_n' },
  finishingCosts: [
    {
      id: 'divine-orb',
      label: 'Divine Orb',
      quantity: 1,
      tradeQuery: {
        provider: 'poe-trade',
        query: { exchange: { have: ['divine'], want: ['chaos'] } },
        schemaVersion: 1,
      },
    },
  ],
  gameVersion: '3.25',
  id: 'physical-large-cluster',
  materials: [
    {
      id: 'primal-crystallised-lifeforce',
      label: 'Primal Crystallised Lifeforce',
      quantityPerAttempt: 150,
      tradeQuery: {
        provider: 'poe-trade',
        query: {
          exchange: {
            have: ['divine'],
            want: ['primal-crystallised-lifeforce'],
          },
        },
        schemaVersion: 1,
      },
    },
  ],
  output: {
    label: 'Physical Large Cluster Jewel',
    tradeQuery: {
      provider: 'poe-trade',
      query: {
        query: {
          stats: [
            {
              filters: [{ id: 'explicit.stat_3948993189', value: { min: 3 } }],
              type: 'and',
            },
          ],
          status: { option: 'securable' },
          type: 'Large Cluster Jewel',
        },
        sort: { price: 'asc' },
      },
      schemaVersion: 1,
    },
  },
  schemaVersion: 1,
  success: { expectedAttempts: 6, mode: 'expected_attempts' },
  summary: 'Harvest-craft a physical large cluster jewel.',
  tags: ['profit', 'cluster-jewel'],
  title: 'Physical Large Cluster Jewel',
};

export const invalidRecipeV1Fixture = {
  ...validRecipeV1Fixture,
  materials: [
    {
      ...validRecipeV1Fixture.materials[0],
      quantityPerAttempt: 0,
    },
  ],
};
