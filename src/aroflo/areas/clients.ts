import { publicFields, type AreaDefinition } from './types.js';

export const clients = {
  area: 'clients', zone: 'clients', identifier: 'clientid',
  fields: publicFields(['clientid', 'archived', 'postable', 'clientname', 'firstname', 'surname', 'abn', 'shortname', 'phone', 'mobile', 'fax', 'email', 'website', 'termsnote', 'orgs.org.orgid', 'address.addressline1', 'address.addressline2', 'address.suburb', 'address.state', 'address.postcode', 'address.country', 'mailingaddress.addressline1', 'mailingaddress.addressline2', 'mailingaddress.suburb', 'mailingaddress.state', 'mailingaddress.postcode', 'mailingaddress.country']),
  filters: { clientid: ['eq'], archived: ['eq'], postable: ['eq'], clientname: ['eq'] },
  joins: ['locations', 'locationcustomfields', 'contacts', 'customfields', 'priorities', 'documentsandphotos'],
  createFields: ['clientname', 'firstname', 'surname', 'abn', 'shortname', 'phone', 'mobile', 'fax', 'email', 'website', 'termsnote', 'orgs.org.orgid', 'address.addressline1', 'address.addressline2', 'address.suburb', 'address.state', 'address.postcode', 'address.country', 'mailingaddress.addressline1', 'mailingaddress.addressline2', 'mailingaddress.suburb', 'mailingaddress.state', 'mailingaddress.postcode', 'mailingaddress.country'],
  updateFields: ['clientid', 'phone']
} as const satisfies AreaDefinition;
