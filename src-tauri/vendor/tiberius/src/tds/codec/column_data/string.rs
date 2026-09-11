use std::borrow::Cow;

use byteorder::{ByteOrder, LittleEndian};

use crate::{error::Error, sql_read_bytes::SqlReadBytes, tds::Collation, VarLenType};

pub(crate) async fn decode<R>(
    src: &mut R,
    ty: VarLenType,
    len: usize,
    collation: Option<Collation>,
) -> crate::Result<Option<Cow<'static, str>>>
where
    R: SqlReadBytes + Unpin,
{
    use VarLenType::*;

    let data = super::plp::decode(src, len).await?;

    match (data, ty) {
        // Codepages other than UTF
        (Some(buf), BigChar) | (Some(buf), BigVarChar) => {
            let collation = collation.as_ref().unwrap();
            let encoder = collation.encoding()?;

            // [db-studio 패치] 코드페이지로 풀 수 없는 바이트는 U+FFFD 로 바꾼다.
            // 원본은 여기서 `Error::Encoding("invalid sequence")` 를 올려 **결과셋 전체**를
            // 버린다 — 값 하나가 깨졌다는 이유로 테이블을 아예 읽을 수 없게 된다.
            // SSMS·JDBC 도 대체 문자로 보여 준다.
            let (s, _) = encoder.decode_without_bom_handling(buf.as_ref());

            Ok(Some(s.into_owned().into()))
        }
        // UTF-16
        (Some(buf), _) => {
            if buf.len() % 2 != 0 {
                return Err(Error::Protocol("nvarchar: invalid plp length".into()));
            }

            let buf: Vec<_> = buf.chunks(2).map(LittleEndian::read_u16).collect();
            // [db-studio 패치] 짝 없는 서로게이트도 같은 이유로 U+FFFD 로 바꾼다.
            Ok(Some(String::from_utf16_lossy(&buf).into()))
        }
        _ => Ok(None),
    }
}
