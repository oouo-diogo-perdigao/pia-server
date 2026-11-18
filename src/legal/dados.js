// Dados públicos e aprovados das páginas legais (feature 0002, plano técnico, seção 0).
// Cada chave vira um token {{CHAVE}} nos fragmentos de src/legal/conteudo/*.html.
// Não coloque aqui segredos nem valores do .env: só dados públicos aprovados pelo Diogo.
// O domínio das páginas não fica aqui: os links usam o origin de PIA_PUBLIC_URL (tokens ORIGEM e URL_*).

export const DADOS = Object.freeze({
  // P01, P02: controlador e responsável, sem CPF.
  CONTROLADOR_NOME: 'Diogo Passos Perdigão Britto',
  // P03: e-mail de contato, privacidade e titular.
  CONTATO_EMAIL: 'contato@travelrpg.com',
  // P04: o próprio controlador atua como encarregado (DPO), pelo mesmo e-mail.
  ENCARREGADO_NOME: 'Diogo Passos Perdigão Britto',
  ENCARREGADO_EMAIL: 'contato@travelrpg.com',
  // P06: foro e ressalva do consumidor.
  FORO: 'comarca de Belo Horizonte/MG',
  FORO_RESSALVA: 'ressalvado o foro do domicílio do consumidor quando a lei garantir',
  // P07: domínio oficial (texto informativo; os links usam PIA_PUBLIC_URL).
  DOMINIO_OFICIAL: 'travelrpg.com',
  // P05: hospedagem, usado na seção de transferência internacional.
  HOSPEDAGEM_TEXTO: 'no Brasil, onde ficam o servidor e o banco de dados com os dados pessoais da sua conta; a PIA não contrata armazenamento de mídia fora do país, e as mídias, como imagens e áudios, ficam no armazenamento que você conecta, que pode estar fora do Brasil',
  // P09: idade mínima.
  IDADE_MINIMA: '18',
});
