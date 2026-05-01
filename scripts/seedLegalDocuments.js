// ============================================================================
// SEED TARGETED - Solo inserta los documentos legales (Privacidad y Terminos)
// Sin tocar usuarios, roles ni permisos. Seguro de ejecutar en produccion.
// Uso: $env:DATABASE_URL=...; node scripts/seedLegalDocuments.js
// ============================================================================

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const legalDocuments = [
  {
    type: 'PRIVACY_POLICY',
    content: 'POLITICA DE PRIVACIDAD - ALINA\n\nEsta es una version preliminar de la Politica de Privacidad de ALINA. El administrador del sistema debe actualizar este contenido desde la seccion de Configuracion.\n\nALINA, sistema de evidencia digital forense, se compromete a proteger la informacion personal de sus usuarios conforme a la Ley N.° 29733 de Proteccion de Datos Personales del Peru.\n\n1. Datos recolectados\n[Pendiente de redaccion por el administrador]\n\n2. Finalidad del tratamiento\n[Pendiente de redaccion por el administrador]\n\n3. Derechos del titular\n[Pendiente de redaccion por el administrador]\n\n4. Contacto\nPara cualquier consulta sobre esta politica, escribir a contacto@pruebadigital.com'
  },
  {
    type: 'TERMS_AND_CONDITIONS',
    content: 'TERMINOS Y CONDICIONES - ALINA\n\nEsta es una version preliminar de los Terminos y Condiciones de ALINA. El administrador del sistema debe actualizar este contenido desde la seccion de Configuracion.\n\nAl utilizar la plataforma ALINA, el usuario acepta los presentes Terminos y Condiciones.\n\n1. Objeto del servicio\n[Pendiente de redaccion por el administrador]\n\n2. Obligaciones del usuario\n[Pendiente de redaccion por el administrador]\n\n3. Limitacion de responsabilidad\n[Pendiente de redaccion por el administrador]\n\n4. Propiedad intelectual\n[Pendiente de redaccion por el administrador]\n\n5. Jurisdiccion\nEstos Terminos se rigen por las leyes de la Republica del Peru.'
  }
];

async function main() {
  console.log('Insertando documentos legales si no existen...');

  // Buscar primer admin para usarlo como userIdRegistration (opcional)
  let adminUserId = null;
  const admin = await prisma.user.findFirst({
    where: {
      userRoles: {
        some: { role: { name: 'SUPER_ADMIN' } }
      }
    },
    select: { id: true, email: true }
  });
  if (admin) {
    adminUserId = admin.id;
    console.log(`Admin encontrado: ${admin.email} (ID: ${admin.id})`);
  } else {
    console.log('No se encontro admin, los documentos se crearan sin userIdRegistration');
  }

  for (const doc of legalDocuments) {
    const result = await prisma.legalDocument.upsert({
      where: { type: doc.type },
      update: {}, // NO sobreescribe contenido existente
      create: {
        type: doc.type,
        content: doc.content,
        userIdRegistration: adminUserId
      }
    });
    console.log(`  - ${doc.type}: id=${result.id}, registrado: ${result.dateTimeRegistration.toISOString()}`);
  }

  console.log('Listo.');
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error('Error:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
