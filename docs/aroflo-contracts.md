# AroFlo HMAC area allowlist

This is a deliberately narrow contract for the legacy HMAC API. It was curated from the official AroFlo legacy reference embedded in the supplied official Postman collection and its dedicated request scripts; it is not a model of response payloads. Sources retrieved on 2026-09-10: [legacy API base/reference](https://api.aroflo.com/) and [official AroFlo Postman collection](https://www.postman.com/aroflo/workspace/aroflo-api/collection/d73f2bdb-5f73-4498-b88c-32bf44367b8e). The local source snapshot used for this curation is `official-aroflo-postman.json`.

`fields` below contains only filter names, identifiers, and explicit scalar XML leaf paths from dedicated create/update scripts. Nested values use dot paths. Archive, delete, and link-processing actions are intentionally excluded. The source’s formal JOIN guidance is combined with every dedicated official JOIN request script; the resulting union is the `joins` column.

| Area | Zone / identifier | Filter names | Joins | Create fields | Update fields |
| --- | --- | --- | --- | --- | --- |
| Tasks | `tasks` / `taskid` | `task_id`, `jobnumber`, `orgname`, `daterequested`, `duedate`, `linkprocessed`, `salesperson_givenname`, `salesperson_surname`, `salesperson_id` | `documentsandphotos`, `notes`, `tasknotes`, `assignedhistory`, `material`, `materials`, `labour`, `expense`, `purchaseorders`, `assets`, `customfields`, `location`, `locationcustomfields`, `project`, `tasktotals`, `substatus`, `salesperson`, `quote` | `org.orgid`, `client.clientid`, `tasktype.tasktypeid`, `taskname`, `duedate`, `description`, `contactname`, `contactphone`, `custon` | `taskid`, `taskname`, `status`, `project.projectid`, `stage.stageid`, `substatus.substatusid` |
| Clients | `clients` / `clientid` | `clientid`, `archived`, `postable`, `clientname` | `locations`, `locationcustomfields`, `contacts`, `customfields`, `priorities`, `documentsandphotos` | `clientname`, `firstname`, `surname`, `abn`, `shortname`, `phone`, `mobile`, `fax`, `email`, `website`, `termsnote`, `orgs.org.orgid`, `address.*`, `mailingaddress.*` | `clientid`, `phone` |
| Locations | `locations` / `locationid` | `createdutc` | — | — | — |
| Quotes | `quotes` / `quoteid` | `quoteid` | `documentsandphotos`, `lineitems`, `notes`, `projects`, `trackingcentres` | — | — |
| Invoices | `invoices` / `invoiceid` | `status`, `linkprocessed`, `taskid` | `lineitems`, `trackingcentres`, `task`, `project` | — | `invoiceid`, `status` |
| Schedules | `schedules` / `scheduleid` | `groupid`, `scheduledtotype`, `scheduledtoid`, `startdate`, `startdatetime`, `taskid` | — | `scheduletype.typeid`, `scheduletype.type`, `startdate`, `insertedby.userid`, `enddate`, `note`, `enddatetime`, `scheduledto.scheduledtoid`, `scheduledto.scheduledtotype`, `startdatetime` | — |
| Users | `users` / `userid` | `archived`, `createdutc`, `position`, `userid` | `customfields`, `permissiongroups`, `documentsandphotos`, `notes`, `trackingcentredefaults`, `featureaccess` | `givennames`, `surname`, `username`, `password`, `accesstype`, `org.orgid` | `userid`, `mobile` |
| Assets | `assets` / `assetid` | `category` | `location`, `customfields`, `notes`, `documentsandphotos` | `assetname`, `modelnumber`, `manufacturer`, `category.categoryid`, `datecreated` | `assetid`, `location.locationid` |
| Inventory | `inventory` / `itemid` | `assignedtotype`, `createdutc` | `stocklevels` | `partnumber`, `description`, `manufacturer`, `costex`, `sellsimple`, `category.categoryid` | `itemid`, `stocklevels.stocklevel.assignedtoid`, `stocklevels.stocklevel.assignedtotype`, `stocklevels.stocklevel.movequantity` |

## Curation rulings and source discrepancies

- Locations and Quotes are read-only. Schedules are create-only. Invoices are update-only through the collection’s explicit `Update Processed Invoices` request; this is still a financial area and must pass the separate financial-write gate.
- The dedicated `Create Schedule` script serializes a `<schedules>` payload but incorrectly builds `zone=clients`. Its schedule read scripts consistently use `zone=schedules`, so this allowlist uses `schedules`; accepting the script’s `clients` value would make a schedule write target the wrong area.
- The collection’s documented task JOIN examples use both `material` and `materials`, and both `notes` and `tasknotes`. Both spellings are retained as the requested union rather than silently normalised.
- `linkprocessed` remains a read filter where the source uses it, but no link-processing mutation is exposed.

For the complete public field-name inventory, use `tests/fixtures/official-contract-summary.json`; it intentionally contains no example payload values or credentials.
