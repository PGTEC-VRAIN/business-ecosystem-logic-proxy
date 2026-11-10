/* Estado del servicio de avisos por correo: instantánea de los pedidos ya notificados
 * y mes del último resumen enviado. Un único documento (_id 'state'). */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const mailStateSchema = new Schema({
    _id: { type: String },
    baselined: { type: Boolean, default: false },
    // { [orderId]: { state, items: { [itemId]: state } } }
    snapshot: { type: Schema.Types.Mixed, default: {} },
    // 'YYYY-MM' del último mes para el que ya se ha comprobado el resumen mensual
    summaryMonth: { type: String, default: '' }
}, { minimize: false });

module.exports = mongoose.model('mailState', mailStateSchema);
