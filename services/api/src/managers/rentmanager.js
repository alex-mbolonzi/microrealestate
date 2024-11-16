import * as Contract from './contract.js';
import * as FD from './frontdata.js';
import {
  Collections,
  logger,
  ServiceError,
  Model
} from '@microrealestate/common';
import axios from 'axios';
import moment from 'moment';
import { Parser } from 'json2csv';

async function _findOccupants(realm, tenantId, startTerm, endTerm) {
  const filter = {
    $query: {
      $and: [{ realmId: realm._id }]
    }
  };
  if (tenantId) {
    filter['$query']['$and'].push({ _id: tenantId });
  }
  if (startTerm && endTerm) {
    filter['$query']['$and'].push({ 'rents.term': { $gte: startTerm } });
    filter['$query']['$and'].push({ 'rents.term': { $lte: endTerm } });
  } else if (startTerm) {
    filter['$query']['$and'].push({ 'rents.term': startTerm });
  }

  const dbTenants = await Collections.Tenant.find(filter.$query)
    .sort({
      name: 1
    })
    .lean();

  return dbTenants.map((tenant) => {
    tenant._id = String(tenant._id);
    if (startTerm && endTerm) {
      tenant.rents = tenant.rents.filter(
        (rent) => rent.term >= startTerm && rent.term <= endTerm
      );
    } else if (startTerm) {
      tenant.rents = tenant.rents.filter((rent) => rent.term === startTerm);
    }
    return tenant;
  });
}

async function _getEmailStatus(
  authorizationHeader,
  locale,
  realm,
  startTerm,
  endTerm
) {
  const { DEMO_MODE, EMAILER_URL } =
    Service.getInstance().envConfig.getValues();
  try {
    let emailEndPoint = `${EMAILER_URL}/status/${startTerm}`;
    if (endTerm) {
      emailEndPoint = `${EMAILER_URL}/status/${startTerm}/${endTerm}`;
    }
    const response = await axios.get(emailEndPoint, {
      headers: {
        authorization: authorizationHeader,
        organizationid: String(realm._id),
        'Accept-Language': locale
      }
    });
    logger.debug(response.data);
    return response.data.reduce((acc, status) => {
      const data = {
        sentTo: status.sentTo,
        sentDate: status.sentDate
      };
      if (!acc[status.recordId]) {
        acc[status.recordId] = { [status.templateName]: [] };
      }
      let documents = acc[status.recordId][status.templateName];
      if (!documents) {
        documents = [];
        acc[status.recordId][status.templateName] = documents;
      }
      documents.push(data);
      return acc;
    }, {});
  } catch (error) {
    logger.error(error);
    if (DEMO_MODE) {
      logger.info('email status fallback workflow activated in demo mode');
      return {};
    } else {
      throw error.data;
    }
  }
}

async function _getRentsDataByTerm(
  authorizationHeader,
  locale,
  realm,
  currentDate,
  frequency
) {
  const startTerm = Number(currentDate.startOf(frequency).format('YYYYMMDDHH'));
  const endTerm = Number(currentDate.endOf(frequency).format('YYYYMMDDHH'));

  const [dbOccupants, emailStatus = {}] = await Promise.all([
    _findOccupants(realm, null, startTerm, endTerm),
    _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      startTerm,
      endTerm
    ).catch(logger.error)
  ]);

  // compute rents
  const rents = dbOccupants.reduce((acc, occupant) => {
    acc.push(
      ...occupant.rents
        .filter((rent) => rent.term >= startTerm && rent.term <= endTerm)
        .map((rent) =>
          FD.toRentData(rent, occupant, emailStatus?.[occupant._id])
        )
    );
    return acc;
  }, []);

  // compute rents overview
  const overview = {
    countAll: 0,
    countPaid: 0,
    countPartiallyPaid: 0,
    countNotPaid: 0,
    totalToPay: 0,
    totalPaid: 0,
    totalNotPaid: 0
  };
  rents.reduce((acc, rent) => {
    if (rent.totalAmount <= 0 || rent.newBalance >= 0) {
      acc.countPaid++;
    } else if (rent.payment > 0) {
      acc.countPartiallyPaid++;
    } else {
      acc.countNotPaid++;
    }
    acc.countAll++;
    acc.totalToPay += rent.totalToPay;
    acc.totalPaid += rent.payment;
    acc.totalNotPaid -= rent.newBalance < 0 ? rent.newBalance : 0;
    return acc;
  }, overview);

  return { overview, rents };
}

////////////////////////////////////////////////////////////////////////////////
// Exported functions
////////////////////////////////////////////////////////////////////////////////
export async function update(req, res) {
  const realm = req.realm;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'];
  const paymentData = req.body;
  const term = `${paymentData.year}${paymentData.month}0100`;

  res.json(
    await _updateByTerm(authorizationHeader, locale, realm, term, paymentData)
  );
}

export async function updateByTerm(req, res) {
  const realm = req.realm;
  const term = req.params.term;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'];
  const paymentData = req.body;

  res.json(
    await _updateByTerm(authorizationHeader, locale, realm, term, paymentData)
  );
}

async function _updateByTerm(
  authorizationHeader,
  locale,
  realm,
  term,
  paymentData
) {
  if (!paymentData.promo && paymentData.promo <= 0) {
    paymentData.promo = 0;
    paymentData.notepromo = null;
  }

  if (!paymentData.extracharge && paymentData.extracharge <= 0) {
    paymentData.extracharge = 0;
    paymentData.noteextracharge = null;
  }

  const occupant = await Collections.Tenant.findOne({
    _id: paymentData._id,
    realmId: realm._id
  }).lean();

  const contract = {
    frequency: occupant.frequency || 'months',
    begin: occupant.beginDate,
    end: occupant.endDate,
    discount: occupant.discount || 0,
    vatRate: occupant.vatRatio,
    properties: occupant.properties,
    rents: occupant.rents
  };

  const settlements = {
    payments: [],
    debts: [],
    discounts: [],
    description: ''
  };

  if (paymentData) {
    if (paymentData.payments && paymentData.payments.length) {
      settlements.payments = paymentData.payments
        .filter(({ amount }) => amount && Number(amount) > 0)
        .map((payment) => ({
          date: payment.date || '',
          amount: Number(payment.amount),
          type: payment.type || '',
          reference: payment.reference || '',
          description: payment.description || ''
        }));
    }

    if (paymentData.promo) {
      settlements.discounts.push({
        origin: 'settlement',
        description: paymentData.notepromo || '',
        amount:
          paymentData.promo *
          (contract.vatRate ? 1 / (1 + contract.vatRate) : 1)
      });
    }

    if (paymentData.extracharge) {
      settlements.debts.push({
        description: paymentData.noteextracharge || '',
        amount:
          paymentData.extracharge *
          (contract.vatRate ? 1 / (1 + contract.vatRate) : 1)
      });
    }

    if (paymentData.description) {
      settlements.description = paymentData.description;
    }
  }

  occupant.rents = Contract.payTerm(contract, term, settlements).rents;

  const emailStatus =
    (await _getEmailStatus(
      authorizationHeader,
      locale,
      realm,
      Number(term)
    ).catch(logger.error)) || {};

  const savedOccupant = await Collections.Tenant.findOneAndUpdate(
    {
      _id: occupant._id,
      realmId: realm._id
    },
    occupant,
    { new: true }
  ).lean();

  const rent = savedOccupant.rents.filter(
    (rent) => rent.term === Number(term)
  )[0];

  return FD.toRentData(
    rent,
    savedOccupant,
    emailStatus?.[String(savedOccupant._id)]
  );
}

export async function rentsOfOccupant(req, res) {
  const realm = req.realm;
  const { id } = req.params;
  const term = Number(moment().format('YYYYMMDDHH'));

  const dbOccupants = await _findOccupants(realm, id);
  if (!dbOccupants.length) {
    return res.sendStatus(404);
  }

  const dbOccupant = dbOccupants[0];
  const rentsToReturn = dbOccupant.rents.map((currentRent) => {
    const rent = FD.toRentData(currentRent);
    if (currentRent.term === term) {
      rent.active = 'active';
    }
    rent.vatRatio = dbOccupant.vatRatio;
    return rent;
  });

  res.json({
    occupant: FD.toOccupantData(dbOccupant),
    rents: rentsToReturn
  });
}

export async function rentOfOccupantByTerm(req, res) {
  const realm = req.realm;
  const { id, term } = req.params;

  res.json(
    await _rentOfOccupant(
      req.headers.authorization,
      req.headers['accept-language'],
      realm,
      id,
      term
    )
  );
}

async function _rentOfOccupant(
  authorizationHeader,
  locale,
  realm,
  tenantId,
  term
) {
  const [dbOccupants = [], emailStatus = {}] = await Promise.all([
    _findOccupants(realm, tenantId, Number(term)).catch(logger.error),
    _getEmailStatus(authorizationHeader, locale, realm, Number(term)).catch(
      logger.error
    )
  ]);

  if (!dbOccupants.length) {
    throw new ServiceError('tenant not found', 404);
  }
  const dbOccupant = dbOccupants[0];

  if (!dbOccupant.rents.length) {
    throw new ServiceError('rent not found', 404);
  }
  const rent = FD.toRentData(
    dbOccupant.rents[0],
    dbOccupant,
    emailStatus?.[dbOccupant._id]
  );
  if (rent.term === Number(moment().format('YYYYMMDDHH'))) {
    rent.active = 'active';
  }
  rent.vatRatio = dbOccupant.vatRatio;

  return rent;
}

export async function all(req, res) {
  const realm = req.realm;

  let currentDate = moment().startOf('month');
  if (req.params.year && req.params.month) {
    currentDate = moment(`${req.params.month}/${req.params.year}`, 'MM/YYYY');
  }

  res.json(
    await _getRentsDataByTerm(
      req.headers.authorization,
      req.headers['accept-language'],
      realm,
      currentDate,
      'months'
    )
  );
}

async function _checkDuplicatePayment(tenant, paymentDate, amount) {
  // Look for existing payments within the same day with same amount
  const existingPayment = await Collections.Rent.findOne({
    'occupant._id': tenant._id,
    payments: {
      $elemMatch: {
        date: {
          $gte: moment(paymentDate).startOf('day').toDate(),
          $lte: moment(paymentDate).endOf('day').toDate()
        },
        amount: amount
      }
    }
  });
  return existingPayment !== null;
}

async function _processBulkPayments(authorizationHeader, locale, realm, payments) {
  const results = {
    successful: [],
    failed: []
  };

  if (!Array.isArray(payments)) {
    throw new ServiceError('Invalid payments data format', 400);
  }

  if (payments.length === 0) {
    throw new ServiceError('No payments provided', 400);
  }

  console.log(`Processing ${payments.length} payments`);

  for (const payment of payments) {
    try {
      console.log(`Processing payment for tenant ${payment.tenant_reference}`);
      
      const tenant = await Collections.Tenant.findOne({
        realm,
        reference: payment.tenant_reference
      });

      if (!tenant) {
        throw new ServiceError(`Tenant with reference ${payment.tenant_reference} not found`, 404);
      }

      // Check for duplicate payment
      const isDuplicate = await _checkDuplicatePayment(
        tenant,
        payment.payment_date,
        payment.amount
      );

      if (isDuplicate) {
        throw new ServiceError('Duplicate payment detected - similar payment exists for same day and amount', 409);
      }

      // Process the payment using existing logic
      await _updateByTerm(
        authorizationHeader,
        locale,
        realm,
        tenant._id,
        {
          payments: [{
            date: payment.payment_date,
            amount: payment.amount,
            type: payment.payment_type,
            reference: payment.reference,
            description: payment.description,
            promo_amount: payment.promo_amount,
            promo_note: payment.promo_note,
            extra_charge: payment.extra_charge,
            extra_charge_note: payment.extra_charge_note
          }]
        }
      );

      results.successful.push({
        tenant_reference: payment.tenant_reference,
        amount: payment.amount,
        status: 'success',
        payment_date: payment.payment_date
      });

      console.log(`Successfully processed payment for tenant ${payment.tenant_reference}`);
    } catch (error) {
      console.error(`Failed to process payment for tenant ${payment.tenant_reference}:`, error);
      
      results.failed.push({
        tenant_reference: payment.tenant_reference,
        amount: payment.amount,
        payment_date: payment.payment_date,
        error: error.message,
        status: 'failed'
      });
    }
  }

  // Generate CSV for failed records
  if (results.failed.length > 0) {
    try {
      const fields = [
        'tenant_reference',
        'payment_date',
        'amount',
        'error',
        'status'
      ];
      
      const json2csvParser = new Parser({ fields });
      results.failedRecordsCsv = json2csvParser.parse(results.failed);
    } catch (error) {
      console.error('Failed to generate CSV for failed records:', error);
      // Don't throw, just log the error as this is not critical
    }
  }

  console.log(`Bulk payment processing complete. Success: ${results.successful.length}, Failed: ${results.failed.length}`);
  return results;
}

export async function uploadBulkPayments(req, res) {
  try {
    if (!req.body || !req.body.payments) {
      throw new ServiceError('No payment data provided', 400);
    }

    console.log('Starting bulk payment upload process');
    const results = await _processBulkPayments(
      req.headers.authorization,
      req.headers['accept-language'],
      req.realm,
      req.body.payments
    );
    
    const response = {
      successful: results.successful,
      failed: results.failed,
      failedRecordsCsv: results.failedRecordsCsv,
      summary: {
        total: req.body.payments.length,
        successful: results.successful.length,
        failed: results.failed.length
      }
    };

    console.log('Bulk payment upload complete', response.summary);
    res.json(response);
  } catch (error) {
    console.error('Bulk payment upload error:', error);
    if (error instanceof ServiceError) {
      throw error;
    }
    throw new ServiceError(error.message || 'Failed to process bulk payments', error.status || 500);
  }
}
