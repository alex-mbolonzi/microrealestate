import * as Contract from './contract.js';
import * as FD from './frontdata.js';
import * as BL from '../businesslogic/index.js';
import {
  Collections,
  logger,
  ServiceError
} from '@microrealestate/common';
import axios from 'axios';
import moment from 'moment';

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
async function update(req, res) {
  const realm = req.realm;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'];
  const paymentData = req.body;
  const term = `${paymentData.year}${paymentData.month}0100`;

  try {
    const result = await _updateByTerm(authorizationHeader, locale, realm, term, paymentData);
    res.json(result);
  } catch (error) {
    logger.error('Error in update:', error);
    const statusCode = error instanceof ServiceError ? 400 : 500;
    const errorResponse = {
      error: error instanceof ServiceError ? error.message : 'Internal server error',
      details: error.details || error.message
    };
    res.status(statusCode).json(errorResponse);
  }
}

async function updateByTerm(req, res) {
  const realm = req.realm;
  const term = req.params.term;
  const authorizationHeader = req.headers.authorization;
  const locale = req.headers['accept-language'];
  const paymentData = req.body;

  try {
    const result = await _updateByTerm(authorizationHeader, locale, realm, term, paymentData);
    res.json(result);
  } catch (error) {
    logger.error('Error in updateByTerm:', error);
    const statusCode = error instanceof ServiceError ? 400 : 500;
    const errorResponse = {
      error: error instanceof ServiceError ? error.message : 'Internal server error',
      details: error.details || error.message
    };
    res.status(statusCode).json(errorResponse);
  }
}

async function rentsOfOccupant(req, res) {
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

async function rentOfOccupantByTerm(req, res) {
  const realm = req.realm;
  const { id, term } = req.params;

  try {
    const result = await _rentOfOccupant(
      req.headers.authorization,
      req.headers['accept-language'],
      realm,
      id,
      term
    );
    res.json(result);
  } catch (error) {
    logger.error('Error in rentOfOccupantByTerm:', error);
    const statusCode = error instanceof ServiceError ? 400 : 500;
    const errorResponse = {
      error: error instanceof ServiceError ? error.message : 'Internal server error',
      details: error.details || error.message
    };
    res.status(statusCode).json(errorResponse);
  }
}

async function all(req, res) {
  const realm = req.realm;

  let currentDate = moment().startOf('month');
  if (req.params.year && req.params.month) {
    currentDate = moment(`${req.params.month}/${req.params.year}`, 'MM/YYYY');
    
    // Validate that the requested date is not in the future
    const now = moment().endOf('month');
    if (currentDate.isAfter(now)) {
      return res.status(400).json({
        error: 'Cannot retrieve or create rents for future months'
      });
    }
  }

  try {
    // First try to find existing rents
    let result = await _getRentsDataByTerm(
      req.headers.authorization,
      req.headers['accept-language'],
      realm,
      currentDate,
      'months'
    );

    // If no rents exist for this period, create them for active tenants
    if (!result.rents.length) {
      const tenants = await Collections.Tenant.find({
        realmId: realm._id,
        'rents.0': { $exists: true }, // Has at least one rent
        $or: [
          { endDate: { $gte: currentDate.toDate() } },
          { terminationDate: { $gte: currentDate.toDate() } }
        ]
      }).lean();

      for (const tenant of tenants) {
        const contract = {
          begin: tenant.beginDate,
          end: tenant.terminationDate || tenant.endDate,
          frequency: tenant.frequency || 'months',
          properties: tenant.properties,
          vatRate: tenant.vatRatio,
          discount: tenant.discount,
          rents: tenant.rents || []
        };

        // Create rent for the current period if within contract dates
        const momentBegin = moment(contract.begin);
        const momentEnd = moment(contract.end);
        
        if (currentDate.isBetween(momentBegin, momentEnd, 'month', '[]')) {
          const rent = BL.computeRent(
            contract,
            currentDate.format('DD/MM/YYYY HH:mm'),
            tenant.rents[tenant.rents.length - 1]
          );
          
          // Save the new rent
          await Collections.Tenant.updateOne(
            { _id: tenant._id },
            { $push: { rents: rent } }
          );
        }
      }

      // Fetch the newly created rents
      result = await _getRentsDataByTerm(
        req.headers.authorization,
        req.headers['accept-language'],
        realm,
        currentDate,
        'months'
      );
    }

    res.json(result);
  } catch (error) {
    logger.error(error);
    res.status(500).json({
      error: 'Failed to retrieve or create rents',
      details: error.message
    });
  }
}

async function _updateByTerm(
  authorizationHeader,
  locale,
  realm,
  term,
  paymentData
) {
  if (!paymentData || !paymentData._id) {
    throw new ServiceError(`Invalid payment data: missing tenant ID`);
  }

  // Validate payments array
  if (!Array.isArray(paymentData.payments)) {
    throw new ServiceError(`Invalid payment data: payments must be an array`);
  }

  // Validate each payment in the array
  paymentData.payments.forEach((payment, index) => {
    if (!payment.date || !payment.type || !payment.amount) {
      throw new ServiceError(`Invalid payment at index ${index}: missing required fields (date, type, amount)`);
    }
    if (typeof payment.amount !== 'number') {
      payment.amount = Number(payment.amount);
      if (isNaN(payment.amount)) {
        throw new ServiceError(`Invalid payment at index ${index}: amount must be a number`);
      }
    }
  });

  const occupant = await Collections.Tenant.findOne({
    _id: paymentData._id,
    realmId: realm._id
  }).lean();

  if (!occupant) {
    throw new ServiceError(`Tenant not found with ID ${paymentData._id}`);
  }

  // Ensure all payment data fields are properly formatted
  const formattedPaymentData = {
    promo: Number(paymentData.promo) || 0,
    notepromo: paymentData.promo > 0 ? (paymentData.notepromo || null) : null,
    extracharge: Number(paymentData.extracharge) || 0,
    noteextracharge: paymentData.extracharge > 0 ? (paymentData.noteextracharge || null) : null,
    description: paymentData.description || '',
    payments: Array.isArray(paymentData.payments) ? paymentData.payments : [],
    _id: paymentData._id
  };

  const beginDate = occupant.beginDate instanceof Date ? occupant.beginDate : new Date(occupant.beginDate);
  const endDate = occupant.endDate instanceof Date ? occupant.endDate : new Date(occupant.endDate);

  if (!beginDate || isNaN(beginDate.getTime()) || !endDate || isNaN(endDate.getTime())) {
    throw new ServiceError(`Tenant ${paymentData._id} has invalid contract dates (beginDate: ${occupant.beginDate}, endDate: ${occupant.endDate})`);
  }

  const contract = {
    frequency: 'months',  // Always use monthly frequency for payments
    begin: beginDate,
    end: endDate,
    discount: occupant.discount || 0,
    vatRate: occupant.vatRatio || 0,
    properties: occupant.properties || [],
    rents: occupant.rents || []
  };

  const settlements = {
    payments: formattedPaymentData.payments,
    debts: [],
    discounts: [],
    description: formattedPaymentData.description
  };

  if (formattedPaymentData.promo > 0) {
    settlements.discounts.push({
      origin: 'settlement',
      description: formattedPaymentData.notepromo || '',
      amount: formattedPaymentData.promo * (contract.vatRate ? 1 / (1 + contract.vatRate) : 1)
    });
  }

  if (formattedPaymentData.extracharge > 0) {
    settlements.debts.push({
      description: formattedPaymentData.noteextracharge || '',
      amount: formattedPaymentData.extracharge * (contract.vatRate ? 1 / (1 + contract.vatRate) : 1)
    });
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

function _checkDuplicatePayment(tenant, paymentDate, amount) {
  return tenant.rents.some((rent) => {
    return rent.payments.some((payment) => {
      return (
        payment.date === paymentDate &&
        payment.amount === amount
      );
    });
  });
}

export {
  update,
  updateByTerm,
  rentsOfOccupant,
  rentOfOccupantByTerm,
  all
};