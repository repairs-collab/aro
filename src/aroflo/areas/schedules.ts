import { publicFields, type AreaDefinition } from './types.js';

export const schedules = {
  area: 'schedules', zone: 'schedules', identifier: 'scheduleid',
  fields: publicFields(['scheduleid', 'groupid', 'scheduledtotype', 'scheduledtoid', 'startdate', 'startdatetime', 'taskid', 'scheduletype.typeid', 'scheduletype.type', 'insertedby.userid', 'enddate', 'note', 'enddatetime', 'scheduledto.scheduledtoid', 'scheduledto.scheduledtotype']),
  filters: { groupid: ['eq'], scheduledtotype: ['eq'], scheduledtoid: ['eq'], startdate: ['eq', 'gte', 'lt'], startdatetime: ['eq'], taskid: ['eq'] }, joins: [],
  createFields: ['scheduletype.typeid', 'scheduletype.type', 'startdate', 'insertedby.userid', 'enddate', 'note', 'enddatetime', 'scheduledto.scheduledtoid', 'scheduledto.scheduledtotype', 'startdatetime'], updateFields: []
} as const satisfies AreaDefinition;
