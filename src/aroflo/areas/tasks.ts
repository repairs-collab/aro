import { publicFields, type AreaDefinition } from './types.js';

export const tasks = {
  area: 'tasks', zone: 'tasks', identifier: 'taskid',
  fields: publicFields(['taskid', 'task_id', 'jobnumber', 'orgname', 'daterequested', 'duedate', 'linkprocessed', 'salesperson_givenname', 'salesperson_surname', 'salesperson_id', 'org.orgid', 'client.clientid', 'tasktype.tasktypeid', 'taskname', 'description', 'contactname', 'contactphone', 'custon', 'project.projectid', 'stage.stageid', 'status', 'substatus.substatusid']),
  filters: { task_id: ['eq'], jobnumber: ['eq'], orgname: ['eq'], daterequested: ['gt'], duedate: ['gt', 'gte', 'lt'], linkprocessed: ['eq'], salesperson_givenname: ['eq'], salesperson_surname: ['eq'], salesperson_id: ['eq'] },
  joins: ['documentsandphotos', 'notes', 'tasknotes', 'assignedhistory', 'material', 'materials', 'labour', 'expense', 'purchaseorders', 'assets', 'customfields', 'location', 'locationcustomfields', 'project', 'tasktotals', 'substatus', 'salesperson', 'quote'],
  createFields: ['org.orgid', 'client.clientid', 'tasktype.tasktypeid', 'taskname', 'duedate', 'description', 'contactname', 'contactphone', 'custon'],
  updateFields: ['taskid', 'taskname', 'status', 'project.projectid', 'stage.stageid', 'substatus.substatusid']
} as const satisfies AreaDefinition;
